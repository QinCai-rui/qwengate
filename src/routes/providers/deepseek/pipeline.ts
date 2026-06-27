/*
 * File: providers/deepseek/pipeline.ts
 * DeepSeek web chat API pipeline — converts OpenAI requests to DeepSeek's internal format.
 * PoW challenge handling, session management, SSE streaming.
 */

import type { Context } from 'hono';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { logStore } from '../../../services/logStore.ts';

const BASE_URL = 'https://chat.deepseek.com';
const CHAT_ENDPOINT = '/api/v0/chat/completion';
const POW_ENDPOINT = '/api/v0/chat/create_pow_challenge';

// ponytail: simple in-memory PoW cache per session
const powCache = new Map<string, { nonce: string; expiresAt: number }>();

/**
 * Convert OpenAI-format messages to DeepSeek prompt string.
 * DeepSeek uses a single prompt string, not messages array.
 */
function messagesToPrompt(messages: Array<{ role: string; content: string | null }>): string {
  return messages
    .map((m) => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
      return `${role}: ${m.content ?? ''}`;
    })
    .join('\n');
}

/**
 * Solve DeepSeek PoW challenge.
 * Returns x-ds-pow-response header value.
 */
async function solvePowChallenge(bearerToken: string): Promise<string | null> {
  try {
    const challengeRes = await fetch(`${BASE_URL}${POW_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!challengeRes.ok) return null;
    const data: any = await challengeRes.json();
    const { challenge, difficulty } = data.data || data;

    // Simple PoW solver: find nonce where SHA256(challenge + nonce) starts with `difficulty` zeros
    // Using Web Crypto API (available in Bun)
    const encoder = new TextEncoder();
    const targetPrefix = '0'.repeat(difficulty || 4);

    for (let nonce = 0; nonce < 1000000; nonce++) {
      const hash = await crypto.subtle.digest('SHA-256', encoder.encode(challenge + nonce));
      const hex = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      if (hex.startsWith(targetPrefix)) {
        return String(nonce);
      }
    }
    return null;
  } catch (err: any) {
    logStore.log('warn', 'deepseek-pow', `PoW failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate a UUID v4 session ID for DeepSeek chat sessions.
 */
function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Proxy a request through DeepSeek's web chat API.
 */
export async function proxyViaDeepSeekWebChat(c: Context, body: OpenAIRequest, bearerToken: string): Promise<Response> {
  const model = body.model.replace(/^deepseek\//, '');
  const isStream = body.stream === true;

  // 1. Solve PoW challenge
  const powResponse = await solvePowChallenge(bearerToken);
  if (!powResponse) {
    logStore.log('warn', 'deepseek', 'PoW challenge failed for deepseek proxy');
    // Fall through — maybe it's not required for this session
  }

  // 2. Build request body in DeepSeek web chat format
  const sessionId = generateSessionId();
  const prompt = messagesToPrompt(body.messages || []);

  const deepseekBody: Record<string, any> = {
    chat_session_id: sessionId,
    parent_message_id: null,
    model_type: model === 'deepseek-reasoner' ? 'reasoner' : 'default',
    prompt: prompt,
    ref_file_ids: [],
    thinking_enabled: model === 'deepseek-reasoner',
    search_enabled: false,
    action: null,
    preempt: false,
  };

  // 3. Build headers
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (powResponse) {
    headers['x-ds-pow-response'] = powResponse;
  }

  // 4. Send request to DeepSeek web chat API
  try {
    const resp = await fetch(`${BASE_URL}${CHAT_ENDPOINT}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(deepseekBody),
      signal: AbortSignal.timeout(120000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown error');
      return c.json(
        {
          error: {
            message: `DeepSeek web chat API error (${resp.status}): ${errText}`,
            type: 'upstream_error',
          },
        },
        resp.status as any,
      );
    }

    // 5. Convert SSE stream from DeepSeek format to OpenAI format
    const contentType = resp.headers.get('content-type') || '';
    if (!isStream || contentType.includes('json')) {
      // Non-streaming: read entire body
      const text = await resp.text();
      // DeepSeek returns SSE even for non-stream: parse it
      const lines = text.split('\n').filter((l) => l.startsWith('data: '));
      const content = lines
        .map((l) => {
          try {
            const parsed = JSON.parse(l.slice(6));
            return parsed.content || parsed.delta || '';
          } catch {
            return '';
          }
        })
        .join('');

      return c.json({
        id: sessionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: content || ' ',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // Streaming: pass-through with format conversion
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const encoder2 = new TextEncoder();

    // Read DeepSeek SSE, convert to OpenAI SSE format
    (async () => {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await writer.write(encoder2.encode('data: [DONE]\n\n'));
            await writer.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          // Parse DeepSeek SSE events
          // Format: data: {"type":"delta","content":"..."} or {"type":"thinking","content":"..."}
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6);
            if (raw === '[DONE]') {
              await writer.write(encoder2.encode('data: [DONE]\n\n'));
              continue;
            }
            try {
              const parsed = JSON.parse(raw);
              const deltaContent = parsed.content || parsed.delta || '';
              if (deltaContent) {
                const oaiEvent = JSON.stringify({
                  id: sessionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: deltaContent },
                      finish_reason: null,
                    },
                  ],
                });
                await writer.write(encoder2.encode(`data: ${oaiEvent}\n\n`));
              }
            } catch {
              // Skip unparseable lines
            }
          }
        }
      } catch (err: any) {
        logStore.log('error', 'deepseek-stream', `Stream error: ${err.message}`);
        await writer.close().catch(() => {});
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err: any) {
    return c.json(
      {
        error: {
          message: `DeepSeek proxy error: ${err.message}`,
          type: 'proxy_error',
        },
      },
      502,
    );
  }
}
