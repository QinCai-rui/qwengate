/*
 * File: providers/deepseek/pipeline.ts
 * DeepSeek web chat API pipeline — converts OpenAI requests to DeepSeek's internal format.
 * Full flow: build context -> solve PoW -> create session -> send chat -> parse SSE.
 */

import type { Context } from 'hono';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { logStore } from '../../../services/logStore.ts';
import { getAccountByEmail, getProviderState, getProviderToken } from '../../../services/accountManager.ts';
import { getOrCreateChatSession, getCurrentUser } from './session.ts';
import { getPowResponseHeader } from './pow.ts';
import { buildDeepSeekHeaders, createDeepSeekContext, DEEPSEEK_BASE_URL } from './spoofing.ts';
import { createStreamState, parseDeepSeekData, type DeepSeekStreamState } from './stream.ts';

const CHAT_ENDPOINT = '/api/v0/chat/completion';

/**
 * Convert OpenAI messages to a single prompt string (DeepSeek web chat uses prompt, not messages).
 */
function messagesToPrompt(messages: Array<{ role: string; content: string | null }>): string {
  return messages
    .map(function (m) {
      var role: string;
      if (m.role === 'assistant') role = 'Assistant';
      else if (m.role === 'system') role = 'System';
      else role = 'User';
      return role + ': ' + (m.content ?? '');
    })
    .join('\n');
}

/**
 * Get the deepseek provider state for an account email.
 * Returns the bearer token from the account's provider state, or null.
 */
function getDeepSeekTokenForEmail(email: string): string | null {
  var state = getProviderState(email, 'deepseek');
  if (state && state.token) return state.token;
  return null;
}

/**
 * Proxy a request through DeepSeek's web chat API.
 * Full flow: build context -> solve PoW -> create session -> send chat -> parse SSE.
 *
 * If accountEmail is omitted, picks any account with a valid deepseek token.
 */
export async function proxyViaDeepSeekWebChat(c: Context, body: OpenAIRequest, accountEmail?: string): Promise<Response> {
  var model = body.model.replace(/^deepseek\//, '');
  var isStream = body.stream === true;

  // 1. Get bearer token
  var bearerToken: string | null = null;
  var email: string = accountEmail || '';

  if (email) {
    bearerToken = getDeepSeekTokenForEmail(email);
  } else {
    // Fall back to any account with deepseek token
    bearerToken = getProviderToken('deepseek');
  }

  if (!bearerToken) {
    return c.json(
      {
        error: {
          message: 'No DeepSeek account logged in. Login via dashboard first.',
          type: 'auth_error',
        },
      },
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }

  // 2. Build spoofing context
  var ctx = createDeepSeekContext(bearerToken);

  // 3. Solve PoW challenge
  var powHeader: string | null = null;
  try {
    powHeader = await getPowResponseHeader(email || 'unknown', bearerToken);
  } catch (err: any) {
    logStore.log('warn', 'deepseek-pow', 'PoW solving failed: ' + err.message + ' — proceeding without PoW');
  }

  // 4. Get or create chat session
  var session = await getOrCreateChatSession(bearerToken);
  if (!session) {
    logStore.log('warn', 'deepseek-session', 'Failed to create chat session');
    return c.json(
      {
        error: {
          message: 'Failed to create DeepSeek chat session. Token may be expired.',
          type: 'auth_error',
        },
      },
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }

  // 5. Build the DeepSeek web chat request body
  var prompt = messagesToPrompt(body.messages || []);
  var modelType = model === 'deepseek-reasoner' ? 'reasoner' : session.model_type || 'default';

  var deepseekBody: Record<string, any> = {
    chat_session_id: session.id,
    parent_message_id: null,
    model_type: modelType,
    prompt: prompt,
    ref_file_ids: [],
    thinking_enabled: model === 'deepseek-reasoner',
    search_enabled: true,
    action: null,
    preempt: false,
  };

  // 6. Build spoofed browser headers (include wafToken from provider state)
  var wafToken = getProviderState(email, 'deepseek')?.wafToken || undefined;
  var headers = buildDeepSeekHeaders(ctx, {
    powResponse: powHeader || undefined,
    hifLeim: ctx.hifLeim,
    dsSessionId: session.id,
    wafToken: wafToken,
  });

  // 7. Send request to DeepSeek web chat API
  try {
    var resp = await fetch(DEEPSEEK_BASE_URL + CHAT_ENDPOINT, {
      method: 'POST',
      headers: headers as unknown as Record<string, string>,
      body: JSON.stringify(deepseekBody),
      signal: AbortSignal.timeout(120000),
    });

    if (!resp.ok) {
      var errText = await resp.text().catch(function () {
        return 'unknown error';
      });
      return c.json(
        {
          error: {
            message: 'DeepSeek web chat API error (' + resp.status + '): ' + errText,
            type: 'upstream_error',
          },
        },
        { status: resp.status as any, headers: { 'content-type': 'application/json' } },
      );
    }

    var contentType = resp.headers.get('content-type') || '';

    // Non-streaming: buffer entire SSE response and extract content
    if (!isStream) {
      var text = await resp.text();
      var state: DeepSeekStreamState = createStreamState();
      var lines = text.split('\n').filter(function (l) {
        return l.startsWith('data: ');
      });
      for (var i = 0; i < lines.length; i++) {
        var lineData = lines[i].slice(6);
        if (lineData === '[DONE]') continue;
        parseDeepSeekData(lineData, state, body.model, session.id);
      }

      return c.json(
        {
          id: session.id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: state.content || ' ',
              },
              finish_reason: 'stop',
            },
          ],
          usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );
    }

    // 8. Streaming: convert DeepSeek SSE to OpenAI SSE on the fly
    var { readable, writable } = new TransformStream();
    var writer = writable.getWriter();
    var reader = resp.body!.getReader();
    var decoder = new TextDecoder();
    var encoder = new TextEncoder();

    (async function () {
      var buffer = '';
      var state: DeepSeekStreamState = createStreamState();

      try {
        while (true) {
          var result = await reader.read();
          if (result.done) {
            // Flush remaining buffer
            if (buffer.trim()) {
              var dataMatch = buffer.match(/^data: (.+)$/m);
              if (dataMatch) {
                var result2 = parseDeepSeekData(dataMatch[1], state, body.model, session.id);
                for (var k = 0; k < result2.chunks.length; k++) {
                  await writer.write(encoder.encode(result2.chunks[k]));
                }
              }
            }
            // Emit [DONE]
            await writer.write(encoder.encode('data: [DONE]\n\n'));
            await writer.close();
            break;
          }

          buffer += decoder.decode(result.value, { stream: true });

          // Process complete lines from buffer
          var lines2 = buffer.split('\n');
          // Keep the last (potentially incomplete) line in the buffer
          buffer = lines2.pop() || '';

          for (var j = 0; j < lines2.length; j++) {
            var line = lines2[j].trim();

            if (!line) continue;

            // Track event: lines
            if (line.startsWith('event: ')) {
              state._pendingEvent = line.slice(7).trim();
              continue;
            }

            // Process data: lines
            if (line.startsWith('data: ')) {
              var dataContent = line.slice(6).trim();

              // Skip [DONE] (unlikely from DeepSeek, but handle it)
              if (dataContent === '[DONE]') {
                await writer.write(encoder.encode('data: [DONE]\n\n'));
                continue;
              }

              var parseResult = parseDeepSeekData(dataContent, state, body.model, session.id);

              for (var m = 0; m < parseResult.chunks.length; m++) {
                await writer.write(encoder.encode(parseResult.chunks[m]));
              }

              if (parseResult.done) {
                await writer.write(encoder.encode('data: [DONE]\n\n'));
                await writer.close();
                return;
              }
            }
          }
        }
      } catch (err: any) {
        logStore.log('error', 'deepseek-stream', 'Stream error: ' + err.message);
        try {
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          await writer.close();
        } catch {
          // writer may already be closed
        }
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
          message: 'DeepSeek proxy error: ' + err.message,
          type: 'proxy_error',
        },
      },
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }
}
