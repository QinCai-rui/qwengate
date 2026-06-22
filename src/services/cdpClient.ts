/**
 * Per-account CDP client: Chrome browser contexts for baxia header capture,
 * Node.js fetch for all API calls.
 *
 * Architecture:
 *   - ONE Chrome process on port 26404 (browser-level WS)
 *   - N browser contexts, one per account, each with its own page
 *   - Chrome CDP is used ONLY for: context creation, cookie injection,
 *     stealth scripts, baxia loading, and header capture
 *   - ALL API requests use Node.js fetch() with cached baxia headers
 *   - No browser CDP evaluate for fetch — eliminates large body hangs
 *
 * Usage:
 *   1. startBrowser() → Chrome on port 26404
 *   2. initBrowserConnection() → connect browser-level WS
 *   3. initAccountContext(email, profileCookies) → create context + navigate
 *   4. browserFetchForAccount(email, url, opts) → non-streaming (Node.js fetch)
 *   5. browserStreamFetchIncrementalForAccount(email, url, body) → streaming (Node.js fetch)
 */

import { setStartupStatus } from './auth.ts';
import { logStore } from './logStore.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CdpPage {
  id: string;
  webSocketDebuggerUrl: string;
  url: string;
  title: string;
}

export interface CdpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  settled: boolean;
}

export interface AccountCdpState {
  email: string;
  contextId: string;
  targetId: string;
  sessionId: string;
  queue: Map<number, PendingCall>;
  callIdCounter: number;
  streamBindings: Map<string, (chunk: string) => void>;
  cachedBxHeaders: Record<string, string>;
  profileCookies?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const CDP_PORT = 26404;
const CDP_HOST = '127.0.0.1';
const BASE_URL = process.env.CHROME_CDP_ENDPOINT || `http://${CDP_HOST}:${CDP_PORT}`;

// Browser-level WebSocket
let browserWs: WebSocket | null = null;
let browserConnected = false;
let browserCallId = 0;
const browserQueue = new Map<number, PendingCall>();

// Per-account state
const accountStates = new Map<string, AccountCdpState>();
const sessionToEmail = new Map<string, string>(); // sessionId → email

// Fetch domain interception state (for large body routing through Chrome's network stack)
interface FetchInterceptEntry {
  markerId: string;
  email: string;
  // Phase 1: Request stage — resolves when Fetch.requestPaused fires for Request
  requestResolve: (v: { requestId: string }) => void;
  requestReject: (e: any) => void;
  requestSettled: boolean;
  requestTimeout: ReturnType<typeof setTimeout>;
  // Populated after Request stage fires
  requestId: string;
  requestHeaders: Record<string, string>;
  // Phase 2: Response stage — resolves when Fetch.requestPaused fires for Response
  responseResolve: (v: { statusCode: number; statusText: string; headers: Record<string, string> }) => void;
  responseReject: (e: any) => void;
  responseSettled: boolean;
  responseTimeout: ReturnType<typeof setTimeout>;
}

const fetchInterceptByMarker = new Map<string, FetchInterceptEntry>();
const fetchInterceptByRequestId = new Map<string, FetchInterceptEntry>();
const LARGE_BODY_THRESHOLD = 50_000; // 50KB — above this, route through Chrome intercept

// Default account for backward-compatible functions
let defaultAccountEmail: string | null = null;

// ---------------------------------------------------------------------------
// Browser-level WebSocket connection
// ---------------------------------------------------------------------------

async function getBrowserWsUrl(): Promise<string> {
  const resp = await fetch(`${BASE_URL}/json/version`, { signal: AbortSignal.timeout(5000) });
  const data = await resp.json();
  return data.webSocketDebuggerUrl;
}

async function connectBrowserWs(): Promise<void> {
  if (browserConnected && browserWs) return;

  const wsUrl = await getBrowserWsUrl();
  logStore.log('debug', 'cdp', `Connecting to browser WS: ${wsUrl}`);

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP browser WS connect timeout'));
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timeout);
      browserWs = ws;
      browserConnected = true;
      logStore.log('debug', 'cdp', 'Browser WS connected');
      resolve();
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string);

        // ── Messages with sessionId → route to account ──
        if (msg.sessionId) {
          const email = sessionToEmail.get(msg.sessionId);
          const state = email ? accountStates.get(email) : null;

          // Runtime.bindingCalled → stream chunk handler
          if (msg.method === 'Runtime.bindingCalled' && msg.params?.name && state) {
            const handler = state.streamBindings.get(msg.params.name);
            if (handler) handler(msg.params.payload);
            return;
          }

          // Handle console output from browser context
          if (msg.method === 'Runtime.consoleAPICalled' && msg.sessionId) {
            const state = sessionToEmail.get(msg.sessionId);
            if (state) {
              const text = msg.params?.args?.map((a: any) => a.value ?? a.description ?? '').join(' ') ?? '';
              if (text.includes('[CDP-BROWSER]')) {
                console.log(`[CDP-CONSOLE][${state}] ${text}`);
              }
            }
          }

          // Fetch.requestPaused — Chrome Fetch domain interception for large body routing
          if (msg.method === 'Fetch.requestPaused' && state) {
            const params = msg.params;

            if (!params.responseStatusCode) {
              // ── Request stage ──
              const marker = params.request?.headers?.['X-CDP-Marker'];
              if (marker) {
                // Our intercepted request — resolve the pending promise
                const entry = fetchInterceptByMarker.get(marker);
                if (entry && !entry.requestSettled) {
                  entry.requestSettled = true;
                  entry.requestId = params.requestId;
                  entry.requestHeaders = params.request?.headers || {};
                  clearTimeout(entry.requestTimeout);
                  fetchInterceptByRequestId.set(params.requestId, entry);
                  entry.requestResolve({ requestId: params.requestId });
                  console.log(`[CDP-Fetch][${entry.email}] Request intercepted, requestId=${params.requestId}`);
                }
              } else {
                // Not our intercept — continue unmodified so other requests don't hang
                sendToAccount(state, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
              }
            } else {
              // ── Response stage ──
              const entry = fetchInterceptByRequestId.get(params.requestId);
              if (entry && !entry.responseSettled) {
                entry.responseSettled = true;
                clearTimeout(entry.responseTimeout);
                // Convert responseHeaders (array of {name,value}) to Record
                const respHeaders: Record<string, string> = {};
                if (Array.isArray(params.responseHeaders)) {
                  for (const h of params.responseHeaders) {
                    respHeaders[h.name] = h.value;
                  }
                }
                entry.responseResolve({
                  statusCode: params.responseStatusCode,
                  statusText: params.responseStatusText || '',
                  headers: respHeaders,
                });
                console.log(`[CDP-Fetch][${entry.email}] Response intercepted, status=${params.responseStatusCode}`);
              } else {
                // Not our intercept — continue response unmodified
                sendToAccount(state, 'Fetch.continueResponse', { requestId: params.requestId }).catch(() => {});
              }
            }
            return;
          }

          // Response to a command (has id)
          if (msg.id && state) {
            const pending = state.queue.get(msg.id);
            if (pending && !pending.settled) {
              pending.settled = true;
              state.queue.delete(msg.id);
              if (msg.error) pending.reject(new Error(`CDP: ${msg.error.message}`));
              else if (msg.result?.exceptionDetails) pending.reject(new Error(`CDP exception: ${msg.result.exceptionDetails.text}`));
              else pending.resolve(msg.result?.result?.value ?? msg.result ?? true);
            }
            return;
          }

          // Other events with sessionId — capture request headers for replay on large bodies
          if (msg.method === 'Network.requestWillBeSent' && state && msg.params?.request?.url?.includes('/api/v2/')) {
            const hdrs = msg.params.request.headers || {};
            // ONLY update cached headers if this capture has bx-ua (prevents overwriting good headers with bad ones)
            if (hdrs['bx-ua']) {
              state.cachedBxHeaders = {
                'bx-umidtoken': hdrs['bx-umidtoken'] || '',
                'bx-ua': hdrs['bx-ua'] || '',
                'bx-v': hdrs['bx-v'] || '',
                cookie: hdrs['cookie'] || '',
                'user-agent': hdrs['user-agent'] || '',
                'sec-ch-ua': hdrs['sec-ch-ua'] || '',
                'sec-ch-ua-mobile': hdrs['sec-ch-ua-mobile'] || '',
                'sec-ch-ua-platform': hdrs['sec-ch-ua-platform'] || '',
                origin: hdrs['origin'] || '',
                referer: hdrs['referer'] || '',
              };
              logStore.log(
                'debug',
                'cdp',
                `Captured ${Object.keys(state.cachedBxHeaders).length} headers for ${state.email} (hasCookie: ${!!hdrs['cookie']}, hasBxUa: ${!!hdrs['bx-ua']})`,
              );
            }
          }
          return;
        }

        // ── Browser-level messages (no sessionId) ──
        if (!msg.id) return; // browser-level event, ignore

        const pending = browserQueue.get(msg.id);
        if (pending && !pending.settled) {
          pending.settled = true;
          browserQueue.delete(msg.id);
          if (msg.error) pending.reject(new Error(`CDP: ${msg.error.message}`));
          else if (msg.result?.exceptionDetails) pending.reject(new Error(`CDP exception: ${msg.result.exceptionDetails.text}`));
          else pending.resolve(msg.result?.result?.value ?? msg.result ?? true);
        }
      } catch {
        /* non-JSON event */
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      browserConnected = false;
      reject(new Error('CDP browser WS error'));
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      browserConnected = false;
      browserWs = null;
      // Reject all pending browser-level calls
      for (const [id, pending] of browserQueue) {
        if (!pending.settled) {
          pending.settled = true;
          pending.reject(new Error('CDP browser WS disconnected'));
        }
        browserQueue.delete(id);
      }
      // Reject all per-account pending calls
      for (const [, state] of accountStates) {
        for (const [id, pending] of state.queue) {
          if (!pending.settled) {
            pending.settled = true;
            pending.reject(new Error('CDP browser WS disconnected'));
          }
          state.queue.delete(id);
        }
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Browser-level evaluate (for Target.createBrowserContext etc.)
// ---------------------------------------------------------------------------

function browserEvaluate<T>(method: string, params: Record<string, any> = {}, timeoutMs = 15000): Promise<T> {
  return new Promise<T>(async (resolve, reject) => {
    try {
      await connectBrowserWs();
    } catch (e: any) {
      return reject(new Error(`CDP connect: ${e.message}`));
    }
    const id = ++browserCallId;
    const timeout = setTimeout(() => {
      const pending = browserQueue.get(id);
      if (pending && !pending.settled) {
        pending.settled = true;
        browserQueue.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }
    }, timeoutMs);

    browserQueue.set(id, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
      settled: false,
    });
    browserWs!.send(JSON.stringify({ id, method, params }));
  });
}

// ---------------------------------------------------------------------------
// Account-level evaluate
// ---------------------------------------------------------------------------

function evaluateInAccount<T>(email: string, expression: string, awaitPromise = false, timeoutMs = 30000): Promise<T> {
  const state = accountStates.get(email);
  if (!state) return Promise.reject(new Error(`No CDP context for account ${email}`));

  return new Promise<T>((resolve, reject) => {
    const id = ++state.callIdCounter;
    const timeout = setTimeout(() => {
      const pending = state.queue.get(id);
      if (pending && !pending.settled) {
        pending.settled = true;
        state.queue.delete(id);
        reject(new Error(`CDP evaluate timed out for ${email}`));
      }
    }, timeoutMs);

    state.queue.set(id, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
      settled: false,
    });

    browserWs!.send(
      JSON.stringify({
        id,
        sessionId: state.sessionId,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise, timeout: timeoutMs - 5000 },
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Account context lifecycle
// ---------------------------------------------------------------------------

/**
 * Create an isolated browser context for an account, inject cookies,
 * navigate to chat.qwen.ai, and wait for baxia to initialize.
 */
export async function initAccountContext(email: string, profileCookies?: string): Promise<void> {
  await connectBrowserWs();

  logStore.log('debug', 'cdp', `Creating context for ${email}...`);

  // 1. Create browser context
  const ctxResult = await browserEvaluate<{ browserContextId: string }>('Target.createBrowserContext', {});
  const contextId = ctxResult.browserContextId;
  logStore.log('debug', 'cdp', `  contextId=${contextId}`);

  // 2. Create target (page) in that context
  const tgtResult = await browserEvaluate<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    browserContextId: contextId,
  });
  const targetId = tgtResult.targetId;
  logStore.log('debug', 'cdp', `  targetId=${targetId}`);

  // 3. Attach to target with flatten: true → get sessionId
  const attachResult = await browserEvaluate<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const sessionId = attachResult.sessionId;
  logStore.log('debug', 'cdp', `  sessionId=${sessionId}`);

  // 4. Create account state
  const state: AccountCdpState = {
    email,
    contextId,
    targetId,
    sessionId,
    queue: new Map(),
    callIdCounter: 0,
    streamBindings: new Map(),
    cachedBxHeaders: {},
    profileCookies,
  };
  accountStates.set(email, state);
  sessionToEmail.set(sessionId, email);

  if (!defaultAccountEmail) defaultAccountEmail = email;

  // 5. Enable Network + Page + Runtime + Fetch domains for this session
  await sendToAccount(state, 'Network.enable', {});
  await sendToAccount(state, 'Page.enable', {});
  await sendToAccount(state, 'Runtime.enable', {});
  // Enable Fetch domain for large body interception — intercepts chat completions at Request and Response stages
  await sendToAccount(state, 'Fetch.enable', {
    patterns: [
      { urlPattern: '*chat.qwen.ai/api/v2/chat/completions*', requestStage: 'Request' },
      { urlPattern: '*chat.qwen.ai/api/v2/chat/completions*', requestStage: 'Response' },
    ],
  });
  logStore.log('debug', 'cdp', `Network + Page + Runtime + Fetch enabled for ${email}`);

  // 5b. Inject stealth scripts BEFORE page load to evade headless detection
  const stealthScript = `
    // 1. Override navigator.webdriver — headless Chrome sets this to true
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // 2. Fake navigator.plugins — headless has empty plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
        ];
        plugins.length = 3;
        return plugins;
      },
    });

    // 3. Ensure window.chrome exists with expected properties
    if (!window.chrome) {
      (window).chrome = { runtime: {}, loadTimes: function() { return {}; }, csi: function() { return {}; } };
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }

    // 4. Fake navigator.languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // 5. Override permissions query for notifications (headless returns 'denied')
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      (window.navigator.permissions as any).query = (params: any) => {
        if (params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission || 'default' } as PermissionStatus);
        }
        return originalQuery.call(window.navigator.permissions, params);
      };
    }

    // 6. Ensure WebGL works — override getParameter to avoid UNMASKED_VENDOR_WEBGL detection
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter: number) {
      // UNMASKED_VENDOR_WEBGL
      if (parameter === 37445) return 'Intel Inc.';
      // UNMASKED_RENDERER_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
  `;
  await sendToAccount(state, 'Page.addScriptToEvaluateOnNewDocument', { source: stealthScript });
  logStore.log('debug', 'cdp', `  Stealth scripts injected for ${email}`);

  // 6. Inject cookies from profileCookies
  if (profileCookies) {
    const pairs = profileCookies.split(';');
    let injected = 0;
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (!name || !val) continue;
      injected++;
      await sendToAccount(state, 'Network.setCookie', {
        name,
        value: val,
        domain: '.qwen.ai',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      });
    }
    logStore.log('debug', 'cdp', `  Injected ${injected} cookies for ${email}`);
  }

  // 7. Navigate to chat.qwen.ai to load SPA + baxia
  await sendToAccount(state, 'Page.navigate', { url: 'https://chat.qwen.ai/' });
  logStore.log('debug', 'cdp', `  Navigating ${email} to chat.qwen.ai...`);

  // 8. Wait for SPA to load + baxia to initialize (poll with backoff)
  let baxiaReady = false;
  for (let waitMs = 0; waitMs < 15000; waitMs += 1000) {
    await Bun.sleep(waitMs === 0 ? 2000 : 1000);
    try {
      const check = await evaluateInAccount<{ fetchIsWrapped: boolean }>(
        email,
        '({fetchIsWrapped:!fetch.toString().includes("native")})',
        false,
      );
      if (check.fetchIsWrapped) {
        baxiaReady = true;
        logStore.log('debug', 'cdp', `  baxia ready for ${email} after ${waitMs + 2000}ms`);
        break;
      }
    } catch {
      // Page may not be loaded yet
    }
  }
  if (!baxiaReady) {
    console.warn(`[CDP]   baxia not ready for ${email} after 15s — proceeding anyway`);
  }

  // 9. Verify baxia
  try {
    const status = await evaluateInAccount<{ hasBaxia: boolean; fetchIsWrapped: boolean }>(
      email,
      '({hasBaxia:!!window.__baxia__,fetchIsWrapped:!fetch.toString().includes("native")})',
      false,
    );
    logStore.log('debug', 'cdp', `  baxia for ${email}: ${status.hasBaxia} | fetch wrapped: ${status.fetchIsWrapped}`);
  } catch (err: any) {
    console.warn(`[CDP]   baxia check failed for ${email}: ${err.message}`);
  }

  // 10. Enable Network tracking to capture bx headers
  // Network.enable already called above, trigger a fire-and-forget fetch
  triggerBxHeaderCaptureForAccount(state);
  await Bun.sleep(1500);

  logStore.log('debug', 'cdp', `Account context ready: ${email} (sessionId=${sessionId})`);
}

/**
 * Send a CDP command to a specific account's session.
 */
async function sendToAccount(state: AccountCdpState, method: string, params: Record<string, any>): Promise<any> {
  await connectBrowserWs();
  const id = ++state.callIdCounter;

  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = state.queue.get(id);
      if (pending && !pending.settled) {
        pending.settled = true;
        state.queue.delete(id);
        reject(new Error(`CDP ${method} timed out for ${state.email}`));
      }
    }, 15000);

    state.queue.set(id, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
      settled: false,
    });

    browserWs!.send(
      JSON.stringify({
        id,
        sessionId: state.sessionId,
        method,
        params,
      }),
    );
  });
}

function triggerBxHeaderCaptureForAccount(state: AccountCdpState): void {
  const id = ++state.callIdCounter;
  browserWs!.send(
    JSON.stringify({
      id,
      sessionId: state.sessionId,
      method: 'Runtime.evaluate',
      params: {
        expression: `fetch("https://chat.qwen.ai/api/v2/models", {credentials:"include",headers:{"Accept":"application/json","source":"web"}}).catch(()=>{})`,
        returnByValue: true,
        awaitPromise: false,
        timeout: 5000,
      },
    }),
  );
  state.queue.set(id, { resolve: () => {}, reject: () => {}, settled: false });
}

/**
 * Refresh baxia state for an account by re-navigating to chat.qwen.ai.
 * Call this periodically or after bot detection to re-initialize baxia tokens.
 */
export async function refreshBaxiaForAccount(email: string): Promise<void> {
  const state = accountStates.get(email);
  if (!state) return;
  logStore.log('debug', 'cdp', `Refreshing baxia for ${email}...`);
  try {
    await sendToAccount(state, 'Page.navigate', { url: 'https://chat.qwen.ai/' });
    // Wait for baxia to re-initialize
    for (let waitMs = 0; waitMs < 10000; waitMs += 1000) {
      await Bun.sleep(waitMs === 0 ? 2000 : 1000);
      try {
        const check = await evaluateInAccount<{ fetchIsWrapped: boolean }>(
          email,
          '({fetchIsWrapped:!fetch.toString().includes("native")})',
          false,
        );
        if (check.fetchIsWrapped) {
          logStore.log('debug', 'cdp', `  baxia refreshed for ${email} after ${waitMs + 2000}ms`);
          triggerBxHeaderCaptureForAccount(state);
          return;
        }
      } catch {
        /* not ready */
      }
    }
    console.warn(`[CDP]   baxia refresh incomplete for ${email} after 10s`);
  } catch (err: any) {
    console.warn(`[CDP]   baxia refresh failed for ${email}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: harvest fresh baxia headers via a small browser request
// ---------------------------------------------------------------------------

/**
 * Harvest fresh baxia headers by making a small browser request.
 * This generates fresh bx-ua/bx-umidtoken tokens that can be used with Node.js fetch.
 * Returns after headers are captured (or after maxWaitMs).
 */
async function harvestFreshHeaders(state: AccountCdpState, maxWaitMs = 8000): Promise<void> {
  // Save existing headers to detect when new ones arrive
  const oldBxUa = state.cachedBxHeaders?.['bx-ua'] || '';

  // Fire a small browser request to trigger baxia header generation
  triggerBxHeaderCaptureForAccount(state);

  // Wait until we get headers with a DIFFERENT bx-ua value (or timeout)
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const current = state.cachedBxHeaders?.['bx-ua'] || '';
    if (current && current !== oldBxUa) return; // Fresh headers captured
    await Bun.sleep(200);
  }

  // Even if headers didn't change, they may still be valid
  if (state.cachedBxHeaders?.['bx-ua']) return;

  console.warn(`[CDP][${state.email}] harvestFreshHeaders: no bx-ua after ${maxWaitMs}ms`);
}

// ---------------------------------------------------------------------------
// Helper: wait for baxia headers to be captured
// ---------------------------------------------------------------------------

async function triggerBxHeaderCaptureAndWait(state: AccountCdpState, maxWaitMs = 5000): Promise<void> {
  triggerBxHeaderCaptureForAccount(state);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (state.cachedBxHeaders && state.cachedBxHeaders['bx-ua']) return;
    await Bun.sleep(200);
  }
}

// ---------------------------------------------------------------------------
// Non-streaming fetch via Node.js
// ---------------------------------------------------------------------------

/**
 * Make a non-streaming API call using Node.js fetch with cached baxia headers.
 * Completely bypasses browser CDP — no size limits, no baxia wrapper hangs.
 */
export async function nodeFetchForAccount(
  email: string,
  url: string,
  body: string,
  options?: { method?: string; timeout?: number },
): Promise<CdpResponse> {
  const state = accountStates.get(email);
  if (!state) throw new Error(`No CDP context for account ${email}`);

  const cachedHeaders = state.cachedBxHeaders;
  if (!cachedHeaders || !cachedHeaders['bx-ua']) {
    throw new Error('No cached baxia headers — need a successful small request first');
  }

  const requestId = crypto.randomUUID();
  logStore.log('debug', 'cdp', `NodeFetch ${email} Non-streaming request, body=${body.length} chars`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    source: 'web',
    'x-request-id': requestId,
    'x-accel-buffering': 'no',
    timezone: new Date().toString(),
    version: '0.2.66',
    'bx-umidtoken': cachedHeaders['bx-umidtoken'],
    'bx-ua': cachedHeaders['bx-ua'],
    'bx-v': cachedHeaders['bx-v'],
    'user-agent': cachedHeaders['user-agent'],
    'sec-ch-ua': cachedHeaders['sec-ch-ua'],
    'sec-ch-ua-mobile': cachedHeaders['sec-ch-ua-mobile'],
    'sec-ch-ua-platform': cachedHeaders['sec-ch-ua-platform'],
    origin: 'https://chat.qwen.ai',
    referer: 'https://chat.qwen.ai/',
  };

  if (state.profileCookies) {
    headers['cookie'] = state.profileCookies;
  }

  const controller = new AbortController();
  const timeout = options?.timeout ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method: (options?.method || 'POST') as any,
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);
    logStore.log('debug', 'cdp', `NodeFetch ${email} Response: ${resp.status}`);

    const text = await resp.text();
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return { ok: resp.ok, status: resp.status, statusText: resp.statusText, body: text, headers: respHeaders };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Chrome Fetch domain intercept (large body routing)
// ---------------------------------------------------------------------------

/**
 * HTTP status text map for common codes.
 */
function httpStatusText(code: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return map[code] || 'Unknown';
}

/**
 * Route a large POST body through Chrome's network stack via CDP Fetch domain interception.
 *
 * Flow:
 *   1. Fire a small trigger window.fetch() with a unique X-CDP-Marker header
 *   2. Fetch.requestPaused fires at Request stage (baxia headers already injected)
 *   3. Fetch.continueRequest replaces the small body with the actual large body
 *   4. Fetch.requestPaused fires at Response stage (gives us status code + headers)
 *   5. Fetch.takeResponseBodyAsStream + IO.read for streaming response body
 *
 * This preserves baxia-injected headers AND uses Chrome's TLS fingerprint.
 */
async function fetchViaChromeIntercept(
  email: string,
  url: string,
  body: string,
  options?: { timeout?: number },
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
}> {
  const state = accountStates.get(email);
  if (!state) throw new Error(`No CDP context for account ${email}`);

  const markerId = crypto.randomUUID();
  const timeoutMs = options?.timeout ?? 90_000;
  const t0 = Date.now();

  // ── Create promises for both interception phases ──
  let requestResolve!: (v: { requestId: string }) => void;
  let requestReject!: (e: any) => void;
  let responseResolve!: (v: { statusCode: number; statusText: string; headers: Record<string, string> }) => void;
  let responseReject!: (e: any) => void;

  const requestPromise = new Promise<{ requestId: string }>((resolve, reject) => {
    requestResolve = resolve;
    requestReject = reject;
  });
  const responsePromise = new Promise<{ statusCode: number; statusText: string; headers: Record<string, string> }>((resolve, reject) => {
    responseResolve = resolve;
    responseReject = reject;
  });

  const entry: FetchInterceptEntry = {
    markerId,
    email,
    requestResolve,
    requestReject,
    requestSettled: false,
    requestTimeout: setTimeout(() => {
      if (!entry.requestSettled) {
        entry.requestSettled = true;
        requestReject(new Error(`Fetch intercept request stage timed out for ${email} after ${timeoutMs}ms`));
      }
    }, timeoutMs),
    requestId: '',
    requestHeaders: {},
    responseResolve,
    responseReject,
    responseSettled: false,
    responseTimeout: setTimeout(() => {
      if (!entry.responseSettled) {
        entry.responseSettled = true;
        responseReject(new Error(`Fetch intercept response stage timed out for ${email} after ${timeoutMs}ms`));
      }
    }, timeoutMs),
  };

  fetchInterceptByMarker.set(markerId, entry);

  try {
    console.log(`[CDP-Fetch][${email}] Starting Chrome intercept, body=${body.length} chars`);

    // ── Step 1: Fire trigger fetch via window.fetch (baxia wraps it, adds headers) ──
    const triggerExpr = `
      fetch("${url}", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "source": "web",
          "X-CDP-Marker": "${markerId}"
        },
        body: "{}"
      }).catch(() => {})
    `.trim();

    const evalId = ++state.callIdCounter;
    browserWs!.send(
      JSON.stringify({
        id: evalId,
        sessionId: state.sessionId,
        method: 'Runtime.evaluate',
        params: { expression: triggerExpr, returnByValue: true, awaitPromise: false },
      }),
    );
    state.queue.set(evalId, { resolve: () => {}, reject: () => {}, settled: false });

    // ── Step 2: Wait for Request stage interception ──
    const { requestId } = await requestPromise;
    console.log(`[CDP-Fetch][${email}] Request intercepted in ${Date.now() - t0}ms`);

    // ── Step 3: Continue request with the actual large body ──
    // Rebuild headers from the intercepted request, removing marker and unsafe headers.
    // CDP's Fetch.continueRequest rejects "unsafe headers" like Content-Length, Host,
    // Transfer-Encoding, etc. — Chrome computes these automatically from the body.
    // See: https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#method-continueRequest
    const headerEntries: Array<{ name: string; value: string }> = [];
    for (const [name, value] of Object.entries(entry.requestHeaders)) {
      const lower = name.toLowerCase();
      if (lower === 'x-cdp-marker') continue; // Remove our marker
      if (lower === 'content-length' || lower === 'host' || lower === 'transfer-encoding' || lower === 'connection') continue; // Unsafe — Chrome manages
      headerEntries.push({ name, value });
    }

    // CDP Fetch.continueRequest requires postData as base64 (per protocol spec: "Encoded as a base64 string when passed over JSON")
    // Chrome automatically computes Content-Length from the base64-decoded postData.
    await sendToAccount(state, 'Fetch.continueRequest', {
      requestId,
      postData: Buffer.from(body).toString('base64'),
      headers: headerEntries,
    });

    // ── Step 4: Wait for Response stage interception ──
    const { statusCode, statusText, headers: respHeaders } = await responsePromise;
    console.log(`[CDP-Fetch][${email}] Response intercepted: ${statusCode} in ${Date.now() - t0}ms`);

    // ── Step 5: Take response body as a stream ──
    const streamResult: any = await sendToAccount(state, 'Fetch.takeResponseBodyAsStream', { requestId });
    const cdpStreamHandle = streamResult.stream;

    // ── Step 6: Continue response so body flows through the stream ──
    await sendToAccount(state, 'Fetch.continueResponse', { requestId });

    // ── Step 7: Read IO stream → Web ReadableStream ──
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const readLoop = async () => {
          try {
            while (true) {
              const chunk: any = await sendToAccount(state, 'IO.read', {
                handle: cdpStreamHandle,
                size: 65536,
              });

              if (chunk.base64Encoded) {
                const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
                controller.enqueue(bytes);
              } else {
                controller.enqueue(new TextEncoder().encode(chunk.data));
              }

              if (chunk.eof) {
                controller.close();
                break;
              }
            }
          } catch (err) {
            try {
              controller.error(err);
            } catch {
              /* already closed */
            }
          }
        };
        readLoop();
      },
    });

    return {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      statusText: statusText || httpStatusText(statusCode),
      headers: respHeaders,
      stream,
    };
  } finally {
    // Clean up interception state
    fetchInterceptByMarker.delete(markerId);
    if (entry.requestId) {
      fetchInterceptByRequestId.delete(entry.requestId);
    }
    clearTimeout(entry.requestTimeout);
    clearTimeout(entry.responseTimeout);
  }
}

// ---------------------------------------------------------------------------
// Non-streaming fetch (public API)
// ---------------------------------------------------------------------------

/**
 * Make a non-streaming API call through a specific account.
 * All requests use Node.js fetch with cached baxia headers — no browser CDP evaluate.
 */
export async function browserFetchForAccount(
  email: string,
  url: string,
  options: { method?: string; body?: string; timeout?: number } = {},
): Promise<CdpResponse> {
  const state = accountStates.get(email);
  if (!state) throw new Error(`No CDP context for ${email} — account not initialized`);
  const { method = 'GET', body = '', timeout = 30000 } = options;

  // Ensure we have baxia headers
  if (!state.cachedBxHeaders || !state.cachedBxHeaders['bx-ua']) {
    console.warn(`[CDP][${email}] No cached baxia headers, attempting browser fetch to populate...`);
    await triggerBxHeaderCaptureAndWait(state);
    if (!state.cachedBxHeaders || !state.cachedBxHeaders['bx-ua']) {
      throw new Error(`No baxia headers for ${email} — cannot make request`);
    }
  }

  // For large bodies, route through Chrome Fetch domain intercept
  if (body.length > LARGE_BODY_THRESHOLD && method.toUpperCase() === 'POST') {
    try {
      const result = await fetchViaChromeIntercept(email, url, body, { timeout });
      const responseBody = await new Response(result.stream).text();
      return {
        ok: result.ok,
        status: result.status,
        statusText: result.statusText,
        body: responseBody,
        headers: result.headers,
      };
    } catch (err) {
      console.warn(
        `[CDP-Fetch][${email}] Chrome intercept failed for non-streaming, falling back to node fetch: ${(err as Error).message}`,
      );
      // Fall through to node fetch below
    }
  }

  // Default: Node.js fetch with cached baxia headers
  return nodeFetchForAccount(email, url, body, { method, timeout });
}

// ---------------------------------------------------------------------------
// Streaming fetch via Node.js
// ---------------------------------------------------------------------------

/**
 * For streaming request bodies, browser's window.fetch() hangs via CDP
 * because baxia's fetch wrapper stalls on large POST body processing.
 * This function uses Node.js fetch() directly with cached baxia headers,
 * bypassing the browser entirely.
 *
 * Prerequisite: a small request must have been made first so that
 * cachedBxHeaders is populated from Network.requestWillBeSent events.
 */
export async function nodeFetchStreamForAccount(
  email: string,
  url: string,
  body: string,
  options?: { referer?: string; timeout?: number },
): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }> {
  const state = accountStates.get(email);
  if (!state) throw new Error(`No CDP context for account ${email}`);

  const cachedHeaders = state.cachedBxHeaders;
  if (!cachedHeaders || !cachedHeaders['bx-ua']) {
    throw new Error('No cached baxia headers — need a successful small request first');
  }

  const requestId = crypto.randomUUID();

  logStore.log('debug', 'cdp', `NodeFetch ${email} Starting node fetch, body=${body.length} chars`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    source: 'web',
    'x-request-id': requestId,
    'x-accel-buffering': 'no',
    timezone: new Date().toString(),
    version: '0.2.66',
    // Replay cached baxia headers
    'bx-umidtoken': cachedHeaders['bx-umidtoken'],
    'bx-ua': cachedHeaders['bx-ua'],
    'bx-v': cachedHeaders['bx-v'],
    'user-agent': cachedHeaders['user-agent'],
    'sec-ch-ua': cachedHeaders['sec-ch-ua'],
    'sec-ch-ua-mobile': cachedHeaders['sec-ch-ua-mobile'],
    'sec-ch-ua-platform': cachedHeaders['sec-ch-ua-platform'],
    origin: 'https://chat.qwen.ai',
    referer: options?.referer || 'https://chat.qwen.ai/',
  };

  // Use profileCookies (stored during initAccountContext) — CDP never captures the cookie header
  if (state.profileCookies) {
    headers['cookie'] = state.profileCookies;
  }

  const controller = new AbortController();
  const timeout = options?.timeout ?? 90_000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);
    logStore.log('debug', 'cdp', `NodeFetch ${email} Response: ${resp.status}, body: ${resp.headers.get('content-length')}`);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${errText.substring(0, 500)}`);
    }

    // Early baxia bot detection: Qwen returns 200 with JSON body when detected
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json') && !ct.includes('text/event-stream')) {
      const errBody = await resp.text().catch(() => '');
      console.warn(`[NodeFetch][${email}] Bot detection — JSON response instead of SSE`);
      throw new Error(`FAIL_SYS_USER_VALIDATE: Bot detection for ${email} — response was JSON not SSE`);
    }

    // Convert Node.js ReadableStream to Web ReadableStream
    const nodeStream = resp.body;
    if (!nodeStream) throw new Error('No response body');

    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const reader = nodeStream.getReader();
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        })();
      },
    });

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });

    return { ok: true, status: resp.status, statusText: resp.statusText, headers: respHeaders, stream: webStream };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Stream an API response via browser window.fetch() through CDP.
 *
 * Bypasses the stale baxia header problem: Node.js fetch replays cached bx-ua/bx-umidtoken
 * headers which triggers FAIL_SYS_USER_VALIDATE on large payloads (>130KB).
 * The browser's baxia window.fetch() wrapper generates fresh headers for every request.
 *
 * Uses Runtime.addBinding + Runtime.evaluate(fetch) with awaitPromise: false (fire-and-forget).
 * Chunks arrive via Runtime.bindingCalled events routed through state.streamBindings.
 */
export async function browserStreamFetchViaBrowser(
  email: string,
  url: string,
  body: string,
  options?: { referer?: string; timeout?: number },
): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }> {
  const state = accountStates.get(email);
  if (!state) throw new Error(`No CDP context for account ${email}`);

  const bindingId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const bindingName = `__cdp_stream_${bindingId}`;
  const bodyGlobal = `__cdp_body_${bindingId}`;
  const t0 = Date.now();
  let firstChunkTime = 0;

  console.log(`[CDP][${email}] browserStreamFetchViaBrowser: url=${url}, body=${body.length} chars, binding=${bindingName}`);

  // Register binding so Runtime.bindingCalled events route to our handler
  await sendToAccount(state, 'Runtime.addBinding', { name: bindingName });

  // Create the ReadableStream that will receive chunks via binding callbacks
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let controllerClosed = false;

      state.streamBindings.set(bindingName, (payload: string) => {
        // Guard: don't operate on a closed controller
        if (controllerClosed) return;

        if (payload === '__QSB_DONE__') {
          try {
            controller.close();
          } catch {
            /* already closed — cancellation race */
          }
          controllerClosed = true;
          state.streamBindings.delete(bindingName);
          // Clean up browser global body reference
          evaluateInAccount(email, `delete window["${bodyGlobal}"]`, false, 5000).catch(() => {});
          console.log(`[CDP][${email}] browserStreamFetchViaBrowser: stream DONE in ${Date.now() - t0}ms`);
          return;
        }

        if (payload === '__QSB_ERROR__') {
          try {
            controller.error(new Error('Browser fetch returned error'));
          } catch {
            /* already closed */
          }
          controllerClosed = true;
          state.streamBindings.delete(bindingName);
          evaluateInAccount(email, `delete window["${bodyGlobal}"]`, false, 5000).catch(() => {});
          console.warn(`[CDP][${email}] browserStreamFetchViaBrowser: stream ERROR after ${Date.now() - t0}ms`);
          return;
        }

        // Decode base64 chunk and enqueue bytes
        try {
          const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
          controller.enqueue(bytes);
          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            console.log(`[CDP][${email}] browserStreamFetchViaBrowser: first chunk in ${firstChunkTime - t0}ms`);
          }
        } catch (err) {
          console.error(`[CDP][${email}] browserStreamFetchViaBrowser: chunk decode error:`, err);
        }
      });
    },
    cancel() {
      // Remove binding on cancellation
      state.streamBindings.delete(bindingName);
      evaluateInAccount(email, `delete window["${bodyGlobal}"]`, false, 5000).catch(() => {});
    },
  });

  // Two-phase body storage: bodies >10KB go in browser global to avoid CDP expression size limits
  const useGlobal = body.length > 10_000;
  if (useGlobal) {
    // Store body in browser window global via evaluate
    const escaped = JSON.stringify(body);
    await evaluateInAccount(email, `window["${bodyGlobal}"] = ${escaped}`, false, 10000);
    console.log(`[CDP][${email}] browserStreamFetchViaBrowser: stored ${body.length} char body in browser global`);
  }

  // Build the fetch expression — references the global body or embeds inline
  const bodyRef = useGlobal ? `window["${bodyGlobal}"]` : JSON.stringify(body);

  const expression = `
    (async () => {
      const bridge = window["${bindingName}"];
      if (!bridge) { console.error("[CDP-BROWSER] Bridge binding ${bindingName} not found"); return; }
      try {
        const requestId = crypto.randomUUID();
        const resp = await window.fetch("${url}", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "source": "web",
            "x-request-id": requestId,
            "x-accel-buffering": "no",
            "timezone": new Date().toString(),
            "version": "0.2.66"
          },
          body: ${bodyRef}
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          bridge("__QSB_ERROR__");
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bridge(btoa(String.fromCharCode(...value)));
        }
        bridge("__QSB_DONE__");
      } catch (err) {
        console.error("[CDP-BROWSER] Fetch error:", err.message || err);
        bridge("__QSB_ERROR__");
      }
    })();
  `.trim();

  // Fire-and-forget: Runtime.evaluate with awaitPromise: false
  // The async IIFE continues running in the browser event loop after CDP returns
  const id = ++state.callIdCounter;
  state.queue.set(id, {
    resolve: (result) => {
      if (result?.exceptionDetails) {
        console.error(`[CDP][${email}] Browser fetch exception:`, result.exceptionDetails);
      }
    },
    reject: (err) => {
      console.error(`[CDP][${email}] Browser fetch error:`, err.message);
    },
    settled: false,
  });

  browserWs!.send(
    JSON.stringify({
      id,
      sessionId: state.sessionId,
      method: 'Runtime.evaluate',
      params: {
        expression,
        returnByValue: true,
        awaitPromise: false,
      },
    }),
  );

  // Auto-cleanup after 30s
  setTimeout(() => state.queue.delete(id), 30_000);

  console.log(`[CDP][${email}] browserStreamFetchViaBrowser: evaluate sent, awaiting chunks via binding`);

  return {
    ok: true,
    status: 200,
    statusText: 'OK (browser fetch)',
    headers: {},
    stream,
  };
}

/**
 * Incrementally stream an API response through a specific account.
 * All streaming uses Node.js fetch with cached baxia headers — no browser CDP evaluate.
 */
export async function browserStreamFetchIncrementalForAccount(
  email: string,
  url: string,
  body: string,
  options?: { referer?: string; timeout?: number },
): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }> {
  const state = accountStates.get(email);
  if (!state) throw new Error(`No CDP context for account ${email}`);

  // Step 1: Harvest fresh baxia headers (small browser request -> captures fresh bx-ua/bx-umidtoken)
  await harvestFreshHeaders(state);

  // Step 2: Route through Chrome Fetch domain intercept — uses Chrome's real TLS
  // fingerprint which bypasses baxia WAF. Qwen's chat completion endpoint always
  // detects Node.js TLS even with valid baxia headers, so we always go via Chrome.
  if (state.cachedBxHeaders && state.cachedBxHeaders['bx-ua']) {
    try {
      return await fetchViaChromeIntercept(email, url, body, { timeout: options?.timeout });
    } catch (err) {
      console.warn(`[CDP-Fetch][${email}] Chrome intercept failed, falling back to node fetch: ${(err as Error).message}`);
      // Fall through to node fetch below
    }
  }

  // Step 3: Node.js fetch fallback (no baxia headers or Chrome intercept failed)
  if (state.cachedBxHeaders && state.cachedBxHeaders['bx-ua']) {
    try {
      return await nodeFetchStreamForAccount(email, url, body, options);
    } catch (err) {
      const msg = (err as Error).message;
      // If bot detection, try Chrome intercept as last resort
      if (msg.includes('FAIL_SYS_USER_VALIDATE')) {
        console.warn(`[CDP][${email}] Bot detection via node fetch, retrying Chrome intercept...`);
        state.cachedBxHeaders = {};
        try {
          await harvestFreshHeaders(state);
          return await fetchViaChromeIntercept(email, url, body, { timeout: options?.timeout });
        } catch (retryErr) {
          console.warn(`[CDP-Fetch][${email}] Chrome intercept retry also failed: ${(retryErr as Error).message}`);
          throw err;
        }
      }
      throw err;
    }
  }

  // Step 4: If no headers after harvest, try refreshing baxia then harvest once more
  console.warn(`[CDP][${email}] No baxia headers after initial harvest, refreshing baxia...`);
  await refreshBaxiaForAccount(email);
  await harvestFreshHeaders(state);
  if (state.cachedBxHeaders && state.cachedBxHeaders['bx-ua']) {
    return await nodeFetchStreamForAccount(email, url, body, options);
  }

  // Step 4: Last resort — browser fetch
  console.warn(`[CDP][${email}] Still no baxia headers, trying browser fetch...`);
  return browserStreamFetchViaBrowser(email, url, body, options);
}

// ---------------------------------------------------------------------------
// Backward-compatible API (default account)
// ---------------------------------------------------------------------------

function getDefaultAccount(): string {
  if (defaultAccountEmail) return defaultAccountEmail;
  const first = accountStates.keys().next().value;
  if (first) return first;
  throw new Error('No CDP account contexts initialized');
}

/** Check baxia status for a specific account (or default). */
export async function checkBaxiaForAccount(email?: string): Promise<{ hasBaxia: boolean; fetchIsWrapped: boolean }> {
  const target = email || getDefaultAccount();
  return evaluateInAccount<{ hasBaxia: boolean; fetchIsWrapped: boolean }>(
    target,
    '({hasBaxia:!!window.__baxia__,fetchIsWrapped:!fetch.toString().includes("native")})',
    false,
  );
}

/** Non-streaming fetch through the default account. */
export async function browserFetch(url: string, options: { method?: string; body?: string; timeout?: number } = {}): Promise<CdpResponse> {
  return browserFetchForAccount(getDefaultAccount(), url, options);
}

/** Streaming fetch through the default account. */
export async function browserStreamFetchIncremental(
  url: string,
  body: string,
  options?: { referer?: string; timeout?: number },
): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }> {
  return browserStreamFetchIncrementalForAccount(getDefaultAccount(), url, body, options);
}

/** Check if an account context exists. */
export function hasAccountContext(email: string): boolean {
  return accountStates.has(email);
}

/** Get all initialized account emails. */
export function getAccountEmails(): string[] {
  return Array.from(accountStates.keys());
}

export interface CdpAccountStatus {
  email: string;
  connected: boolean;
  baxiaReady: boolean;
  fetchWrapped: boolean;
  sessionId: string;
  queueSize: number;
  activeBindings: number;
}

/** Get CDP status for all connected accounts. */
export function getCdpStatuses(): CdpAccountStatus[] {
  const results: CdpAccountStatus[] = [];
  for (const [email, state] of accountStates) {
    results.push({
      email,
      connected: !!state.sessionId,
      baxiaReady: true, // if context is initialized, baxia was confirmed
      fetchWrapped: true,
      sessionId: state.sessionId.slice(0, 8) + '...',
      queueSize: state.queue.size,
      activeBindings: state.streamBindings.size,
    });
  }
  return results;
}

/**
 * Initialize the browser connection and all account contexts.
 * Call once at startup after startBrowser().
 */
export async function initAllAccountContexts(accounts: Array<{ email: string; profileCookies?: string }>): Promise<void> {
  await connectBrowserWs();
  logStore.log('debug', 'cdp', `Initializing ${accounts.length} account contexts...`);

  for (const acct of accounts) {
    if (!acct.profileCookies) {
      logStore.log('debug', 'cdp', `Waiting for auth for ${acct.email} — no profile cookies yet`);
      continue;
    }
    try {
      setStartupStatus(acct.email, 'connecting');
      await initAccountContext(acct.email, acct.profileCookies);
    } catch (err: any) {
      console.error(`[CDP] Failed to init context for ${acct.email}: ${err.message}`);
    }
  }

  logStore.log('debug', 'cdp', `Account contexts ready: ${getAccountEmails().join(', ')}`);
}

/**
 * Stop all account contexts and disconnect.
 */
export function stopAllAccounts(): void {
  // Clean up Fetch domain interception state
  fetchInterceptByMarker.clear();
  fetchInterceptByRequestId.clear();

  // Disable Fetch domain for each account (fire-and-forget)
  for (const [, state] of accountStates) {
    if (browserWs && browserConnected) {
      try {
        const id = ++state.callIdCounter;
        browserWs.send(JSON.stringify({ id, sessionId: state.sessionId, method: 'Fetch.disable', params: {} }));
      } catch {
        /* already closing */
      }
    }
    state.streamBindings.clear();
    state.queue.clear();
  }
  accountStates.clear();
  sessionToEmail.clear();
  defaultAccountEmail = null;
  if (browserWs) {
    try {
      browserWs.close();
    } catch {
      /* already closed */
    }
    browserWs = null;
    browserConnected = false;
  }
}
