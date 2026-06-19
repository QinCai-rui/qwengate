import crypto from 'node:crypto';
import { CircuitBreaker, CircuitOpenError, withRetry } from '../utils/retry.ts';
import { decrementInFlight, pickAccount, throttleAccount } from './auth.ts';
import { config } from './configService.ts';
import { logStore } from './logStore.ts';
import { completeEntry, createNetworkEntry, errorEntry, recordResponse, recordStreamChunk } from './networkDebug.ts';
import { forceRefreshBxHeaders, getQwenHeaders, performBrowserStream } from './playwright.ts';
import { logQwenRequest, logQwenResponse } from './qwenLogger.ts';

export { configureAccount, deleteAllChats, fetchQwenModels } from './qwenModels.ts';

// Shared URL constants for Qwen API
export const QWEN_API_BASE = 'https://chat.qwen.ai';
export const QWEN_CHAT_COMPLETIONS_URL = `${QWEN_API_BASE}/api/v2/chat/completions`;
export const QWEN_SETTINGS_URL = `${QWEN_API_BASE}/api/v2/users/user/settings/update`;

/** Build shared feature_config for Qwen message payloads. */
export function buildFeatureConfig(enableThinking: boolean): Record<string, any> {
  return {
    thinking_enabled: enableThinking,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: false,
    thinking_mode: 'Thinking',
    thinking_format: 'summary',
    auto_search: true,
  };
}
export const QWEN_CHATS_URL = `${QWEN_API_BASE}/api/v2/chats/`;
export const QWEN_MODELS_URL = `${QWEN_API_BASE}/api/models`;
export const QWEN_BX_V = '2.5.36';

export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

class UpstreamStatusError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UpstreamStatusError';
    this.status = status;
  }
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant' | 'function';
  content: string | Record<string, unknown>;
  user_action: string;
  files: unknown[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: Record<string, unknown>;
  extra: Record<string, unknown>;
  sub_chat_type: string;
  parent_id: string | null;
  // Function-specific fields (only for role: 'function')
  model?: string;
  modelName?: string;
  modelIdx?: number;
  userContext?: unknown;
  info?: Record<string, unknown>;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string | null;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

export interface QwenStreamResult {
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  accountEmail?: string;
  abortController: AbortController;
  qwenLogFile?: string;
}

const QWEN_FETCH_TIMEOUT_MS = config.getInt('QWEN_FETCH_TIMEOUT_MS', 30000);

// Cached timezone for request headers
const cachedTimezone = 'America/Sao_Paulo';

export function createFetchTimeout(): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = QWEN_FETCH_TIMEOUT_MS;
  if (timeout > 0) {
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeout);
    return { controller, cleanup: () => clearTimeout(timer) };
  }
  return { controller, cleanup: () => {} };
}

function buildRequestHeaders(reqHeaders: Record<string, string>, cId?: string): Record<string, string> {
  const bxUmidtoken =
    reqHeaders['bx-umidtoken'] ||
    crypto
      .createHash('sha256')
      .update(reqHeaders['cookie'] || `anon-${Date.now()}`)
      .digest('hex')
      .slice(0, 64);
  const bxUa =
    reqHeaders['bx-ua'] ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5',
    'content-type': 'application/json',
    source: 'web',
    cookie: reqHeaders['cookie'],
    origin: QWEN_API_BASE,
    referer: cId ? `https://chat.qwen.ai/c/${cId}` : 'https://chat.qwen.ai/',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    // Client hints — critical for WAF bypass. Real Chrome sends these automatically,
    // but Node.js fetch() doesn't. Adding them manually tells the WAF this is a
    // real browser request.
    'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    timezone: cachedTimezone,
    'user-agent':
      reqHeaders['user-agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'x-accel-buffering': 'no',
    'x-request-id': crypto.randomUUID(),
    'bx-ua': bxUa,
    'bx-umidtoken': bxUmidtoken,
    'bx-v': reqHeaders['bx-v'] || QWEN_BX_V,
  };
}

const lastRequestTime = new Map<string, number>();
async function applyRequestJitter(accountEmail?: string): Promise<void> {
  if (!accountEmail) return;
  const now = Date.now();
  const last = lastRequestTime.get(accountEmail) || 0;
  const elapsed = now - last;

  // Minimum gap between requests from the same account (1-3 seconds)
  const minGap = 1000 + Math.random() * 2000;
  if (elapsed < minGap) {
    const wait = minGap - elapsed + Math.random() * 500;
    await new Promise((r) => setTimeout(r, wait));
  }

  // Occasional longer pause (10% chance of 2-5s delay — simulates user reading/thinking)
  if (Math.random() < 0.1) {
    const pause = 2000 + Math.random() * 3000;
    await new Promise((r) => setTimeout(r, pause));
  }

  lastRequestTime.set(accountEmail, Date.now());
}

const qwenCircuitBreaker = new CircuitBreaker('qwen-api', {
  // In CDP mode, first requests per context can take longer (baxia warmup).
  // With 8 accounts, we need a higher threshold to avoid premature circuit open.
  failureThreshold: process.env.CHROME_CDP_ENDPOINT ? 15 : 5,
  resetTimeoutMs: process.env.CHROME_CDP_ENDPOINT ? 15_000 : 30_000,
  halfOpenMaxAttempts: 1,
});

export async function createQwenStream(
  messages: QwenMessage[],
  enableThinking: boolean,
  modelId: string,
  chatId?: string,
  parentId?: string | null,
  accountEmail?: string,
  tools?: unknown[],
  toolChoice?: unknown,
): Promise<QwenStreamResult> {
  const actualParentId: string | null = parentId !== undefined ? parentId : null;
  const timestamp = Math.floor(Date.now() / 1000);
  const model = modelId.replace('-no-thinking', '');

  // Ensure each message has required fields
  const qwenMessages: QwenMessage[] = messages.map((msg, i) => ({
    fid: msg.fid || crypto.randomUUID(),
    parentId: msg.parentId || (i === 0 ? actualParentId : null),
    childrenIds: msg.childrenIds || [],
    role: msg.role,
    content: msg.content,
    user_action: msg.user_action || 'chat',
    files: msg.files || [],
    timestamp: msg.timestamp || timestamp,
    models: msg.models || [model],
    chat_type: msg.chat_type || 't2t',
    feature_config: msg.feature_config || buildFeatureConfig(enableThinking),
    extra: msg.extra || { meta: { subChatType: 't2t' } },
    sub_chat_type: msg.sub_chat_type || 't2t',
    parent_id: msg.parent_id ?? (i === 0 ? actualParentId : null),
    // Function-specific fields
    ...(msg.role === 'function'
      ? {
          model: msg.model || model,
          modelName: msg.modelName || modelId,
          modelIdx: msg.modelIdx ?? 0,
          userContext: msg.userContext ?? null,
          info: msg.info || {},
        }
      : {}),
  }));

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId || null,
    chat_mode: 'normal',
    model: model,
    parent_id: actualParentId,
    messages: qwenMessages,
    timestamp: timestamp + 1,
    // Only send tools via feature_config.local_mcp (Qwen native format).
    // Do NOT inject top-level tools/tool_choice — that triggers OpenAI
    // compatibility mode which silently downgrades thinking_format to summary.
    // local_mcp is already populated in chatHelpers.ts when body.tools exist.
  };

  const urlObj = new URL(QWEN_CHAT_COMPLETIONS_URL);
  if (chatId) urlObj.searchParams.set('chat_id', chatId);
  const url = urlObj.href;

  const retryConfig = {
    maxRetries: Math.max(0, config.getInt('RETRY_MAX_ATTEMPTS', 3)),
    baseDelayMs: Math.max(0, config.getInt('RETRY_BASE_DELAY_MS', 1000)),
    maxDelayMs: Math.max(0, config.getInt('RETRY_MAX_DELAY_MS', 30000)),
    backoffMultiplier: Math.max(0.1, config.getFloat('RETRY_BACKOFF_MULTIPLIER', 2)),
    // CDP mode: no per-attempt timeout — the stream has its own idle timeout.
    // Non-CDP mode: 30s default timeout for direct fetch.
    attemptTimeoutMs: process.env.CHROME_CDP_ENDPOINT ? 0 : 30_000,
  };

  const retriesEnabled = config.getBool('RETRY_ENABLED', true);
  let currentAccountEmail = accountEmail;
  let lastDebugEntryId: string | null = null;
  const streamAbortController = new AbortController();

  async function handleErrorResponse(response: Response, debugEntryId: string): Promise<never> {
    const errText = await response.text().catch(() => '');
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const errorJson = JSON.parse(errText);
        if (errorJson?.data?.details?.includes('chat is in progress') || errorJson?.data?.details?.includes('The chat is in progress')) {
          const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
          errorEntry(debugEntryId, errorJson.data.details);
          throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, retryAfterMs);
        }

        if (errorJson?.success === false) {
          const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
          const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
          const wait = errorJson.data?.num !== undefined ? ` Wait about ${errorJson.data.num} hour(s) before trying again.` : '';
          if (code === 'RateLimited' && currentAccountEmail) {
            const throttleMs = (errorJson.data?.num || 1) * 3600_000;
            // Use the full duration from Qwen (e.g. 7 hours) — do NOT cap at 2h.
            // Capping caused accounts to become "available" while Qwen still rejected them.
            throttleAccount(currentAccountEmail, throttleMs);
            const nextAccount = await pickAccount(currentAccountEmail);
            if (nextAccount) {
              currentAccountEmail = nextAccount.email;
              // pickAccount incremented inFlight for the new account, but we're about to throw
              // so decrement it — the caller will retry with a fresh pickAccount
              decrementInFlight(nextAccount.email);
            } else if (!nextAccount) {
              // All accounts are throttled — include wait time in error for the user
              throw new QwenUpstreamError(`All accounts rate-limited. ${details}.${wait}`, code, 429);
            }
          }
          let status: number;
          if (code === 'RateLimited') status = 429;
          else if (code === 'Not_Found') status = 404;
          else if (code === 'UpstreamError') status = 502;
          else status = 502;
          errorEntry(debugEntryId, `${code}: ${details}`);
          throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, status);
        }

        // Qwen anti-bot CAPTCHA — force header refresh and switch accounts
        if (errorJson?.ret?.[0] === 'FAIL_SYS_USER_VALIDATE') {
          const details = errorJson.ret[1] || 'CAPTCHA required';
          logStore.log('warn', 'qwen', `CAPTCHA detected for ${currentAccountEmail || 'unknown'}: ${details}`);
          if (currentAccountEmail) {
            forceRefreshBxHeaders(currentAccountEmail).catch(() => {});
            throttleAccount(currentAccountEmail, 5 * 60 * 1000);
            console.warn(`[Qwen] BOT DETECTION: ${currentAccountEmail} hit FAIL_SYS_USER_VALIDATE — throttled 5min, switching account`);
            const nextAccount = await pickAccount(currentAccountEmail);
            if (nextAccount) {
              currentAccountEmail = nextAccount.email;
              decrementInFlight(nextAccount.email);
            }
          }
          throw new RetryableQwenStreamError(`Qwen CAPTCHA — switched accounts. ${details}`, 3000);
        }

        if (
          errorJson?.data?.details?.includes('is not exist') ||
          errorJson?.data?.details?.includes('not exist') ||
          errorJson?.data?.details?.includes('does not exist')
        ) {
          errorEntry(debugEntryId, errorJson.data.details);
          throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, 0);
        }
      } catch (parseOrRetryError) {
        if (parseOrRetryError instanceof RetryableQwenStreamError || parseOrRetryError instanceof QwenUpstreamError) {
          throw parseOrRetryError;
        }
      }
    }
    const sanitizedErrText = errText
      .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[JWT_REDACTED]')
      .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[JWT_REDACTED]')
      .slice(0, 500);
    throw new UpstreamStatusError(
      `Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${sanitizedErrText}`,
      response.status,
    );
  }

  let makeRequestQwenLogFile: string | undefined;
  const makeRequest = async (): Promise<{ response: Response; headers: Record<string, string>; qwenLogFile?: string }> => {
    // CDP mode: route through real Chrome's network stack
    if (process.env.CHROME_CDP_ENDPOINT) {
      const bodyStr = JSON.stringify(payload);
      console.log(
        `[Qwen] CDP request: url=${url} bodyLen=${bodyStr.length} model=${payload.model} chatId=${payload.chat_id} parentId=${payload.parent_id} msgs=${payload.messages.length} hasTools=${!!(payload as any).tools || !!payload.messages[0]?.feature_config?.local_mcp}`,
      );
      const debugEntry = createNetworkEntry({
        url,
        method: 'POST',
        headers: {},
        body: payload,
        category: 'chat',
        accountEmail: currentAccountEmail,
      });
      lastDebugEntryId = debugEntry.id;
      const _cdpStartTime = Date.now();
      const stream = await performBrowserStream(currentAccountEmail || '', url, bodyStr, streamAbortController.signal);

      // Read first chunk to check for __httpError (sent by performBrowserStream when status is non-2xx)
      const reader = stream.getReader();
      const firstChunk = await reader.read();
      if (firstChunk.done) throw new Error('Browser stream returned empty response');

      const firstText = new TextDecoder().decode(firstChunk.value);
      console.log(
        `[Qwen] CDP first chunk (${firstText.length} bytes) after ${Date.now() - _cdpStartTime}ms: ${firstText.substring(0, 200)}`,
      );
      try {
        const parsed = JSON.parse(firstText);
        if (parsed.__httpError) {
          console.log(
            `[Qwen] CDP HTTP error for ${currentAccountEmail}: status=${parsed.status} body=${(parsed.body || '').substring(0, 300)}`,
          );
          // Create a mock Response so handleErrorResponse can process it
          const mockResponse = new Response(parsed.body, {
            status: parsed.status,
            statusText: parsed.statusText || 'Error',
            headers: { 'content-type': 'application/json' },
          });
          await handleErrorResponse(mockResponse, debugEntry.id);
          // handleErrorResponse always throws, so we never reach here
        }
        // Check for FAIL_SYS_USER_VALIDATE in the first chunk body directly
        if (
          parsed.ret?.[0] === 'FAIL_SYS_USER_VALIDATE' ||
          (typeof parsed.data?.url === 'string' && parsed.data.url.includes('_____tmd_____'))
        ) {
          console.warn(`[Qwen] BOT DETECTION for ${currentAccountEmail}: FAIL_SYS_USER_VALIDATE — throttling account 5min`);
        }
      } catch (parseErr) {
        // If it's a known error type from handleErrorResponse, rethrow it
        if (
          parseErr instanceof RetryableQwenStreamError ||
          parseErr instanceof QwenUpstreamError ||
          parseErr instanceof UpstreamStatusError
        ) {
          throw parseErr;
        }
        // Otherwise it's a JSON parse error — meaning the first chunk is normal SSE data, not an error
      }

      // Normal path: re-enqueue first chunk + pipe remaining reader into a merged stream.
      // Race-safe: Bun's runtime may close the controller BEFORE our cancel() handler runs,
      // so we rely on try-catch around enqueue/close rather than just a boolean guard.
      // The "Controller is already closed" error is a normal cancellation signal, not an error.
      const mergedStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(firstChunk.value);
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // enqueue() can throw if Bun closed the controller before cancel() ran
                try {
                  controller.enqueue(value);
                } catch {
                  return; // Controller already closed — done
                }
              }
            } catch {
              // Stream cancelled — reader.read() threw, exit gracefully
              return;
            }
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          })().catch(() => {}); // Prevent unhandled rejection from fire-and-forget async
        },
        cancel() {
          try {
            reader.cancel();
          } catch {
            /* already cancelled */
          }
        },
      });

      console.log(`[Qwen] CDP stream ready: ${Date.now() - _cdpStartTime}ms total setup time for ${currentAccountEmail}`);
      return { response: new Response(mergedStream), headers: {}, qwenLogFile: undefined };
    }

    const { headers: reqHeaders } = await getQwenHeaders(currentAccountEmail);
    const requestHeaders = buildRequestHeaders(reqHeaders, chatId);
    // Human-like jitter between requests from the same account
    await applyRequestJitter(currentAccountEmail);
    const debugEntry = createNetworkEntry({
      url,
      method: 'POST',
      headers: requestHeaders,
      body: payload,
      category: 'chat',
      accountEmail: currentAccountEmail,
    });
    lastDebugEntryId = debugEntry.id;
    try {
      let response: Response;
      try {
        const { controller, cleanup } = createFetchTimeout();
        const onFetchAbort = () => {
          if (!streamAbortController.signal.aborted) {
            streamAbortController.abort(controller.signal.reason || new Error('Fetch timeout'));
          }
        };
        const onStreamAbort = () => {
          if (!controller.signal.aborted) {
            controller.abort(streamAbortController.signal.reason);
          }
        };
        controller.signal.addEventListener('abort', onFetchAbort);
        streamAbortController.signal.addEventListener('abort', onStreamAbort);
        try {
          const bodyStr = JSON.stringify(payload);

          if (config.get('SAVE_REQUEST_LOGS') === 'true') {
            makeRequestQwenLogFile = logQwenRequest(payload, url);
          }
          response = await fetch(url, {
            method: 'POST',
            headers: requestHeaders,
            body: bodyStr,
            signal: controller.signal,
          });
          const respHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => {
            respHeaders[k] = v;
          });
          if (makeRequestQwenLogFile) logQwenResponse(makeRequestQwenLogFile, response.status, response.statusText, respHeaders, '');
        } finally {
          cleanup();
          controller.signal.removeEventListener('abort', onFetchAbort);
          streamAbortController.signal.removeEventListener('abort', onStreamAbort);
        }
      } catch (fetchErr: unknown) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          logStore.log('warn', 'qwen', 'Request timed out');
          throw new RetryableQwenStreamError('Request timed out', 0);
        }
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        errorEntry(debugEntry.id, msg);
        throw fetchErr;
      }
      recordResponse(debugEntry.id, response);
      if (!response.ok || !response.body) {
        await handleErrorResponse(response, debugEntry.id);
      }
      return { response, headers: reqHeaders, qwenLogFile: makeRequestQwenLogFile };
    } catch (err) {
      errorEntry(debugEntry.id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  let result: { response: Response; headers: Record<string, string>; qwenLogFile?: string };
  const cbState = qwenCircuitBreaker.getState();
  if (cbState === 'open') {
    const stats = qwenCircuitBreaker.getStats();
    const retryAfterMs = Math.max(0, 30_000 - (Date.now() - stats.lastFailureTime));
    throw new CircuitOpenError(retryAfterMs);
  }
  if (retriesEnabled && retryConfig.maxRetries > 0) {
    result = await withRetry(makeRequest, { ...retryConfig, circuitBreaker: qwenCircuitBreaker });
  } else {
    result = await makeRequest();
    await qwenCircuitBreaker.recordSuccess();
  }
  if (!result.response.body) {
    throw new Error(`Qwen returned empty response body (status ${result.response.status})`);
  }
  const streamDebugEntryId = lastDebugEntryId;
  const textDecoder = new TextDecoder();
  const wrappedStream = result.response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (streamDebugEntryId) {
          recordStreamChunk(streamDebugEntryId, textDecoder.decode(chunk, { stream: true }));
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (streamDebugEntryId) {
          completeEntry(streamDebugEntryId);
        }
      },
    }),
  );
  return {
    stream: wrappedStream,
    headers: result.headers,
    uiSessionId: chatId || '',
    accountEmail: currentAccountEmail,
    abortController: streamAbortController,
    qwenLogFile: result.qwenLogFile,
  };
}
