/*
 * File: providers/glm/pipeline.ts
 * GLM Open WebUI pipeline -- converts OpenAI requests to Open WebUI format.
 * Session management, fingerprint params, SSE streaming.
 */

import type { Context } from 'hono';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { logStore } from '../../../services/logStore.ts';

const BASE_URL = 'https://chat.z.ai';

// ponytail: simple in-memory session cache per account token
const sessions = new Map<string, { id: string; userId: string; timestamp: number }>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Build browser fingerprint query parameters for GLM API.
 * These are required by Open WebUI for anti-bot correlation.
 */
function buildFingerprintParams(token: string, userId: string): URLSearchParams {
  const ts = Date.now();
  const params = new URLSearchParams();
  params.set('timestamp', String(ts));
  params.set('requestId', crypto.randomUUID());
  params.set('user_id', userId || '');
  params.set('token', token);
  params.set('user_agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
  params.set('screen_width', '1920');
  params.set('screen_height', '1080');
  // Open WebUI requires these even if unused
  params.set('model', '');
  params.set('title', '');
  return params;
}

/**
 * Get or create a chat session for this user.
 * GLM needs a session to be created via POST /api/v1/chats/new.
 */
async function getOrCreateSession(bearerToken: string): Promise<{ sessionId: string; userId: string } | null> {
  // Check cache
  const cached = sessions.get(bearerToken);
  if (cached && Date.now() - cached.timestamp < SESSION_TTL) {
    return { sessionId: cached.id, userId: cached.userId };
  }

  try {
    // First, get current user info
    const authRes = await fetch(`${BASE_URL}/api/v1/auths/`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!authRes.ok) return null;
    const authData: any = await authRes.json();
    const userId = authData?.user?.id || authData?.id || '';

    // Clean up old sessions for this user
    const sessionsRes = await fetch(`${BASE_URL}/api/v1/chats/`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (sessionsRes.ok) {
      const chatsData: any = await sessionsRes.json();
      const chats = Array.isArray(chatsData) ? chatsData : chatsData?.data || [];
      // Delete old chats (keep max 5)
      for (let i = 5; i < chats.length; i++) {
        fetch(`${BASE_URL}/api/v1/chats/${chats[i].id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${bearerToken}` },
        }).catch(() => {});
      }
    }

    // Create new chat session
    const newId = crypto.randomUUID();
    const chatRes = await fetch(`${BASE_URL}/api/v1/chats/new`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat: {
          id: newId,
          title: 'OpenGate Session',
          models: [],
          params: {},
          history: { messages: {}, currentId: null },
          tags: [],
          flags: [],
          features: [],
          mcp_servers: [],
          enable_thinking: false,
          reasoning_effort: '',
          auto_web_search: false,
          message_version: 1,
          extra: {},
          timestamp: Date.now(),
          type: 'default',
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!chatRes.ok) return null;

    const session = { id: newId, userId, timestamp: Date.now() };
    sessions.set(bearerToken, session);
    return { sessionId: newId, userId };
  } catch (err: any) {
    logStore.log('warn', 'glm-session', `Session error: ${err.message}`);
    return null;
  }
}

/**
 * Convert OpenAI messages to Open WebUI history format.
 */
function messagesToOpenWebUIHistory(
  messages: Array<{ role: string; content: string | null }>,
  _userId: string,
): { messages: Record<string, any>; currentId: string | null } {
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
 * Proxy a request through GLM's Open WebUI API.
 */
export async function proxyViaGlmWebChat(c: Context, body: OpenAIRequest, bearerToken: string): Promise<Response> {
  const isStream = body.stream === true;
  const model = body.model.replace(/^glm\//, '');

  // 1. Get or create chat session
  const session = await getOrCreateSession(bearerToken);
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

  // 2. Convert to Open WebUI format
  const history = messagesToOpenWebUIHistory(body.messages || [], session.userId);

  const webuiBody = {
    chat: {
      id: session.sessionId,
      title: 'OpenGate Session',
      models: [model],
      params: {},
      history: {
        messages: history.messages,
        currentId: history.currentId,
      },
      tags: [],
      flags: [],
      features: [],
      mcp_servers: [],
      enable_thinking: model.includes('glm-5'),
      reasoning_effort: model.includes('glm-5') ? 'max' : '',
      auto_web_search: false,
      message_version: 1,
      extra: {},
      timestamp: Date.now(),
      type: 'default',
    },
  };

  // 3. Build URL with fingerprint params
  const params = buildFingerprintParams(bearerToken, session.userId);
  const url = `${BASE_URL}/api/v2/chat/completions?${params.toString()}`;

  // 4. Build headers
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken}`,
    'Content-Type': 'application/json',
    Cookie: `token=${bearerToken}`,
    'x-request-id': crypto.randomUUID(),
    Accept: 'text/event-stream',
  };

  // 5. Send request
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(webuiBody),
      signal: AbortSignal.timeout(120000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown error');
      return c.json(
        {
          error: {
            message: `GLM API error (${resp.status}): ${errText}`,
            type: 'upstream_error',
          },
        },
        resp.status as any,
      );
    }

    const contentType = resp.headers.get('content-type') || '';

    if (!isStream || contentType.includes('json')) {
      // Non-streaming response
      const data: any = await resp.json();
      return c.json({
        id: session.sessionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: data?.choices || [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: data?.messages?.[0]?.content || data?.content || data?.message?.content || ' ',
            },
            finish_reason: 'stop',
          },
        ],
        usage: data?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // Streaming: pass-through with format conversion
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    (async () => {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await writer.write(encoder.encode('data: [DONE]\n\n'));
            await writer.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6);
            if (raw === '[DONE]') {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
              continue;
            }
            try {
              const parsed = JSON.parse(raw);
              // Open WebUI SSE: { choices: [{ delta: { content }, finish_reason }] }
              // or { content: "..." }
              const deltaContent =
                parsed?.choices?.[0]?.delta?.content ||
                parsed?.choices?.[0]?.message?.content ||
                parsed?.content ||
                parsed?.message?.content ||
                '';
              if (deltaContent) {
                const oaiEvent = JSON.stringify({
                  id: session.sessionId,
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
                await writer.write(encoder.encode(`data: ${oaiEvent}\n\n`));
              }
            } catch {
              // Skip unparseable lines
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
