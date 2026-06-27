/*
 * File: providers/glm/pipeline.ts
 * GLM proxy pipeline — full flow with captcha solving, session management,
 * browser fingerprint spoofing, x-signature HMAC, and three-phase SSE parsing.
 */

import type { Context } from 'hono';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { logStore } from '../../../services/logStore.ts';
import { getOrCreateChatSession, getCurrentUser } from './session.ts';
import { buildFingerprintParams, buildGlmHeaders, buildGlmVariables, GLM_BASE_URL } from './spoofing.ts';
import { type GlmStreamState, createGlmStreamState, parseGlmSseLine } from './stream.ts';

export interface GlmProxyContext {
  jwt: string;
  userId: string;
  userName: string;
}

/**
 * Build the GLM proxy context from account state.
 * Validates JWT and fetches user info.
 */
export async function buildGlmContext(jwt: string): Promise<GlmProxyContext | null> {
  try {
    const user = await getCurrentUser(jwt);
    if (!user) return null;
    return {
      jwt,
      userId: user.id,
      userName: user.name,
    };
  } catch (err: any) {
    logStore.log('warn', 'glm-pipeline', `buildGlmContext error: ${err.message}`);
    return null;
  }
}

/**
 * Convert OpenAI messages to GLM history format.
 */
function messagesToGlmFormat(messages: Array<{ role: string; content: string | null }>): {
  messages: Record<string, any>;
  currentId: string | null;
} {
  const result: Record<string, any> = {};
  let prevId: string | null = null;
  let currentId: string | null = null;

  for (const msg of messages) {
    const id = crypto.randomUUID();
    currentId = id;
    result[id] = {
      id,
      parentId: prevId,
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content || '',
      timestamp: Date.now(),
      done: true,
    };
    prevId = id;
  }

  return { messages: result, currentId };
}

/**
 * Proxy a request through GLM's chat completions API.
 * Full flow: build context → get/create session → build spoofed request → send → parse SSE.
 */
export async function proxyViaGlmWebChat(c: Context, body: OpenAIRequest, jwt: string): Promise<Response> {
  const isStream = body.stream === true;
  const model = body.model.replace(/^glm\//, '');

  // 1. Build context
  const ctx = await buildGlmContext(jwt);
  if (!ctx) {
    return c.json(
      {
        error: {
          message: 'Cannot validate GLM account. Login via dashboard first.',
          type: 'auth_error',
        },
      },
      503,
    );
  }

  // 2. Get or create chat session
  const session = await getOrCreateChatSession(jwt, model);
  if (!session) {
    return c.json(
      {
        error: {
          message: 'Cannot create GLM chat session. Login via dashboard first.',
          type: 'auth_error',
        },
      },
      503,
    );
  }

  // 3. Convert messages to GLM format
  const history = messagesToGlmFormat(body.messages || []);
  const variables = buildGlmVariables(ctx);

  // ponytail: features and background_tasks must be objects, not arrays — GLM crashes (500) on array types
  const glmFeatures: Record<string, any> = {
    image_generation: false,
    web_search: false,
    auto_web_search: false,
    preview_mode: true,
    flags: [],
    vlm_tools_enable: false,
    vlm_web_search_enable: false,
    vlm_website_mode: false,
    enable_thinking: model.includes('glm-5') || model.includes('glm-4'),
  };

  const glmBody: Record<string, any> = {
    stream: isStream,
    model,
    messages: body.messages || [],
    signature_prompt: (body.messages && body.messages[0]?.content) || '',
    params: {},
    extra: {},
    features: glmFeatures,
    variables,
    chat_id: session.id,
    id: session.id,
    current_user_message_id: history.currentId,
    current_user_message_parent_id: null,
    background_tasks: { title_generation: true, tags_generation: true },
  };

  // 4. Build fingerprint query string
  const params = buildFingerprintParams(ctx);
  const url = `${GLM_BASE_URL}/api/v2/chat/completions?${params.toString()}`;

  // 5. Build spoofed headers with x-signature
  const bodyStr = JSON.stringify(glmBody);
  const requestId = crypto.randomUUID();
  const headers = await buildGlmHeaders(ctx, bodyStr, requestId);

  // 6. Send request to GLM
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(120000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown error');
      logStore.log('warn', 'glm-pipeline', `GLM API error (${resp.status}): ${errText.slice(0, 500)}`);
      return c.json(
        {
          error: {
            message: `GLM API error (${resp.status}): ${errText.slice(0, 500)}`,
            type: 'upstream_error',
          },
        },
        resp.status as any,
      );
    }

    const contentType = resp.headers.get('content-type') || '';

    if (!isStream || contentType.includes('json')) {
      // Non-streaming: read entire body
      const text = await resp.text();

      const lines = text.split('\n').filter((l) => l.startsWith('data: '));
      let fullContent = '';
      let fullThinking = '';
      let usage: any = null;

      for (const line of lines) {
        try {
          const raw = line.slice(6);
          if (raw === '[DONE]') continue;
          const parsed = JSON.parse(raw);
          const data = parsed.data || parsed;
          if (data.phase === 'thinking') {
            fullThinking += data.delta_content || '';
          } else if (data.phase === 'answer') {
            fullContent += data.delta_content || '';
          } else if (data.phase === 'other' && data.usage) {
            usage = data.usage;
          }
        } catch {
          // Skip unparseable lines
        }
      }

      const responseMsg: Record<string, any> = {
        role: 'assistant',
        content: fullContent || ' ',
      };
      if (fullThinking) {
        responseMsg.reasoning_content = fullThinking;
      }

      return c.json({
        id: session.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: responseMsg,
            finish_reason: 'stop',
          },
        ],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // 7. Streaming: convert three-phase SSE to OpenAI format
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const state: GlmStreamState = createGlmStreamState();

    (async () => {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!state.isFinished) {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
            }
            await writer.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line

          for (const line of lines) {
            const { chunks, done: streamDone } = parseGlmSseLine(line, state, model, session.id);
            for (const chunk of chunks) {
              await writer.write(encoder.encode(chunk));
            }
            if (streamDone) {
              await writer.close();
              return;
            }
          }
        }
      } catch (err: any) {
        logStore.log('error', 'glm-stream', `Stream error: ${err.message}`);
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
          message: `GLM proxy error: ${err.message}`,
          type: 'proxy_error',
        },
      },
      502,
    );
  }
}
