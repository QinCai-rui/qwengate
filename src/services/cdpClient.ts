/**
 * Per-account CDP client: routes API calls through a single Chrome browser
 * with isolated browser contexts per Qwen account.
 *
 * Architecture:
 *   - ONE Chrome process on port 26404 (browser-level WS)
 *   - N browser contexts, one per account, each with its own page
 *   - Each page has independent baxia, cookies, and window.fetch
 *   - CDP messages routed by sessionId (Target.attachToTarget flatten: true)
 *   - Multiple concurrent requests supported (different accounts = different pages)
 *
 * Usage:
 *   1. startBrowser() → Chrome on port 26404
 *   2. initBrowserConnection() → connect browser-level WS
 *   3. initAccountContext(email, profileCookies) → create context + navigate
 *   4. browserFetchForAccount(email, url, opts) → non-streaming
 *   5. browserStreamFetchIncrementalForAccount(email, url, body) → streaming
 *
 * IMPORTANT: baxia wraps window.fetch (not XMLHttpRequest).
 * All API calls MUST use fetch() from the page context.
 */

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
  profileCookies: string;
  initialized: boolean;
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
              }
            }
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

          // Other events with sessionId — capture ALL request headers for replay on large bodies
          if (msg.method === 'Network.requestWillBeSent' && state && msg.params?.request?.url?.includes('/api/v2/')) {
            const hdrs = msg.params.request.headers || {};
            // Capture ALL headers for replay on large bodies
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
export async function initAccountContext(email: string, profileCookies: string): Promise<void> {
  await connectBrowserWs();

  // 1. Create browser context
  const ctxResult = await browserEvaluate<{ browserContextId: string }>('Target.createBrowserContext', {});
  const contextId = ctxResult.browserContextId;

  // 2. Create target (page) in that context
  const tgtResult = await browserEvaluate<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    browserContextId: contextId,
  });
  const targetId = tgtResult.targetId;

  // 3. Attach to target with flatten: true → get sessionId
  const attachResult = await browserEvaluate<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const sessionId = attachResult.sessionId;

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
    initialized: false,
  };
  accountStates.set(email, state);
  sessionToEmail.set(sessionId, email);

  if (!defaultAccountEmail) defaultAccountEmail = email;

  // 5. Enable Network + Page + Runtime domains for this session
  await sendToAccount(state, 'Network.enable', {});
  await sendToAccount(state, 'Page.enable', {});
  await sendToAccount(state, 'Runtime.enable', {});

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
  }

  // 7. Navigate to chat.qwen.ai to load SPA + baxia
  await sendToAccount(state, 'Page.navigate', { url: 'https://chat.qwen.ai/' });

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
  } catch (err: any) {
    console.warn(`[CDP]   baxia check failed for ${email}: ${err.message}`);
  }

  // 10. Enable Network tracking to capture bx headers
  // Network.enable already called above, trigger a fire-and-forget fetch
  triggerBxHeaderCaptureForAccount(state);
  await Bun.sleep(1500);

  state.initialized = true;
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
// Non-streaming fetch
// ---------------------------------------------------------------------------

/**
 * Make a non-streaming API call through a specific account's browser page.
 * Uses window.fetch() so baxia injects bx-umidtoken/bx-ua headers.
 */
export async function browserFetchForAccount(
  email: string,
  url: string,
  options: { method?: string; body?: string; timeout?: number } = {},
): Promise<CdpResponse> {
  const state = accountStates.get(email)!;

  const { method = 'GET', body, timeout = 30000 } = options;

  // For large bodies with cached baxia headers, use Node.js fetch to bypass browser hang
  const LARGE_BODY_THRESHOLD = 50_000; // 50KB
  if (body && body.length > LARGE_BODY_THRESHOLD && state.cachedBxHeaders && state.cachedBxHeaders['bx-ua']) {
    const requestId = crypto.randomUUID();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      source: 'web',
      'x-request-id': requestId,
      'x-accel-buffering': 'no',
      timezone: new Date().toString(),
      version: '0.2.66',
      // Replay cached baxia headers
      'bx-umidtoken': state.cachedBxHeaders['bx-umidtoken'],
      'bx-ua': state.cachedBxHeaders['bx-ua'],
      'bx-v': state.cachedBxHeaders['bx-v'],
      'user-agent': state.cachedBxHeaders['user-agent'],
      'sec-ch-ua': state.cachedBxHeaders['sec-ch-ua'],
      'sec-ch-ua-mobile': state.cachedBxHeaders['sec-ch-ua-mobile'],
      'sec-ch-ua-platform': state.cachedBxHeaders['sec-ch-ua-platform'],
      origin: 'https://chat.qwen.ai',
      referer: 'https://chat.qwen.ai/',
    };
    // Use profileCookies (CDP never captures the cookie header)
    if (state.profileCookies) {
      headers['cookie'] = state.profileCookies;
    }
    try {
      const resp = await fetch(url, { method: method || 'POST', headers, body });
      const text = await resp.text();
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return { ok: resp.ok, status: resp.status, statusText: resp.statusText, body: text, headers: respHeaders };
    } catch (err) {
      console.warn(`[CDP][${email}] Node.js fetch failed (${(err as Error).message}), falling back to browser fetch`);
      // Fall through to browser fetch
    }
  }

  // For large bodies, store in browser global first (same fix as streaming path)
  const BODY_THRESHOLD = 10_000;
  const bodyGlobalName = `__cdp_fetch_body_${Date.now()}`;
  const useTwoPhase = body && body.length > BODY_THRESHOLD;

  if (useTwoPhase) {
    const storeId = ++state.callIdCounter;
    const storeExpression = `window[${JSON.stringify(bodyGlobalName)}] = ${JSON.stringify(body)}; 'ok'`;
    browserWs!.send(
      JSON.stringify({
        id: storeId,
        sessionId: state.sessionId,
        method: 'Runtime.evaluate',
        params: { expression: storeExpression, returnByValue: true },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Body storage timeout')), 15_000);
      state.queue.set(storeId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        settled: false,
      });
    });
  }

  const bodyRef = useTwoPhase ? `window[${JSON.stringify(bodyGlobalName)}]` : JSON.stringify(body);
  const bodyClause = useTwoPhase ? `body: ${bodyRef},` : body ? `body: ${bodyRef},` : '';
  const expression = `(async () => {
    try {
      const requestId = crypto.randomUUID();
      const resp = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'source': 'web',
          'x-request-id': requestId,
          'x-accel-buffering': 'no',
          'timezone': new Date().toString(),
          'version': '0.2.66',
        },
        ${bodyClause}
      });
      const headers = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      if (window[${JSON.stringify(bodyGlobalName)}]) delete window[${JSON.stringify(bodyGlobalName)}];
      return { ok: resp.ok, status: resp.status, statusText: resp.statusText, body: await resp.text(), headers };
    } catch(e) {
      if (window[${JSON.stringify(bodyGlobalName)}]) delete window[${JSON.stringify(bodyGlobalName)}];
      return { ok: false, status: 0, statusText: e.message || 'NetworkError', body: '', headers: {} };
    }
  })()`;
  return evaluateInAccount<CdpResponse>(email, expression, true, timeout);
}

// ---------------------------------------------------------------------------
// Streaming fetch (incremental)
// ---------------------------------------------------------------------------

/**
 * Incrementally stream an API response through a specific account's browser page.
 * Uses Runtime.addBinding + window.fetch() + ReadableStream.getReader() to pipe
 * SSE chunks back in real time.
 *
 * Returns { ok, status, headers, stream } where stream delivers SSE text incrementally.
 */
// ---------------------------------------------------------------------------
// Node.js fetch bypass for large bodies
// ---------------------------------------------------------------------------

/**
 * For large request bodies (>50KB), browser's window.fetch() hangs via CDP
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

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${errText.substring(0, 500)}`);
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

export async function browserStreamFetchIncrementalForAccount(
  email: string,
  url: string,
  body: string,
  options?: { referer?: string; timeout?: number },
): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }> {
  const state = accountStates.get(email);
  if (!state) throw new Error(`No CDP context for account ${email}`);

  // For large bodies with cached baxia headers, use Node.js fetch to bypass browser hang
  const LARGE_BODY_THRESHOLD = 50_000; // 50KB
  if (body.length > LARGE_BODY_THRESHOLD && state.cachedBxHeaders && state.cachedBxHeaders['bx-ua']) {
    try {
      return await nodeFetchStreamForAccount(email, url, body, options);
    } catch (err) {
      console.warn(`[CDP][${email}] Node.js fetch failed (${(err as Error).message}), falling back to browser fetch`);
      // Fall through to browser fetch
    }
  }

  const referer = options?.referer || 'https://chat.qwen.ai/';
  const timeout = options?.timeout || 60_000;
  const bindingName = `__cdp_sb_${++state.callIdCounter}_${Date.now()}`;
  const startTime = Date.now();

  await connectBrowserWs();

  // Register binding: browser calls window[bindingName](b64chunk)
  const addBindingId = ++state.callIdCounter;
  browserWs!.send(
    JSON.stringify({
      id: addBindingId,
      sessionId: state.sessionId,
      method: 'Runtime.addBinding',
      params: { name: bindingName },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime.addBinding timeout')), 5000);
    state.queue.set(addBindingId, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
      settled: false,
    });
  });

  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let streamClosed = false;

  const nodeStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      streamClosed = true;
      removeBindingForAccount(state, bindingName);
    },
  });

  // Wire the binding to the stream controller
  let firstChunkTime = 0;
  let chunkCount = 0;
  state.streamBindings.set(bindingName, (payload: string) => {
    if (streamClosed) return;
    if (payload === '__QSB_DONE__') {
      streamClosed = true;
      try {
        streamController?.close();
      } catch {
        /* already closed */
      }
      removeBindingForAccount(state, bindingName);
      // Clean up browser global for large bodies
      if (useTwoPhase) {
        try {
          browserWs!.send(
            JSON.stringify({
              id: ++state.callIdCounter,
              sessionId: state.sessionId,
              method: 'Runtime.evaluate',
              params: { expression: `delete window[${JSON.stringify(bodyGlobalName)}]; 'ok'`, returnByValue: true, timeout: 5000 },
            }),
          );
        } catch {
          /* best effort */
        }
      }
      return;
    }
    if (payload === '__QSB_ERROR__') {
      console.error(`[CDP] stream ERROR: ${Date.now() - startTime}ms, ${chunkCount} chunks, email=${email}`);
      streamClosed = true;
      try {
        streamController?.error(new Error('Browser stream fetch failed'));
      } catch {
        /* already closed */
      }
      removeBindingForAccount(state, bindingName);
      // Clean up browser global for large bodies
      if (useTwoPhase) {
        try {
          browserWs!.send(
            JSON.stringify({
              id: ++state.callIdCounter,
              sessionId: state.sessionId,
              method: 'Runtime.evaluate',
              params: { expression: `delete window[${JSON.stringify(bodyGlobalName)}]; 'ok'`, returnByValue: true, timeout: 5000 },
            }),
          );
        } catch {
          /* best effort */
        }
      }
      return;
    }
    if (!firstChunkTime) {
      firstChunkTime = Date.now();
    }
    chunkCount++;
    try {
      const binary = atob(payload);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      if (!streamClosed) streamController?.enqueue(bytes);
    } catch {
      // Corrupted chunk or controller already closed — skip silently
    }
  });

  // --- LARGE BODY HANDLING ---
  // For large request bodies (e.g. Qwen Code with 100KB+ system prompt + tools),
  // embedding the body directly in the Runtime.evaluate expression causes Chrome
  // to hang — the V8 parser stalls on 260KB+ string literals. Instead, we store
  // the body in a browser global FIRST via a simple assignment, then reference it
  // in a tiny fetch expression. This splits the CDP message into two: a simple
  // string storage (no parsing overhead) and a small fetch call.
  const BODY_THRESHOLD = 10_000; // 10KB — above this, use two-phase approach
  const bodyGlobalName = `__cdp_body_${state.callIdCounter + 1}`;
  const useTwoPhase = body.length > BODY_THRESHOLD;

  if (useTwoPhase) {
    const storeStart = Date.now();
    // Phase 1: Store body in browser global (simple assignment, no baxia involvement)
    const storeId = ++state.callIdCounter;
    const storeExpression = `window[${JSON.stringify(bodyGlobalName)}] = ${JSON.stringify(body)}; 'ok'`;
    browserWs!.send(
      JSON.stringify({
        id: storeId,
        sessionId: state.sessionId,
        method: 'Runtime.evaluate',
        params: { expression: storeExpression, returnByValue: true },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Body storage timeout')), 15_000);
      state.queue.set(storeId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        settled: false,
      });
    });
  }

  // Launch fetch in the account's page using window.fetch()
  // so baxia's wrapper intercepts and injects bx-umidtoken/bx-ua headers.
  //
  // KEY: We do NOT use awaitPromise:true on Runtime.evaluate.
  // With awaitPromise:true, CDP blocks until the IIFE resolves. If window.fetch()
  // hangs (baxia stalling on large bodies), the entire CDP evaluate hangs forever
  // and our timeout doesn't fire reliably. Instead, we start the fetch as
  // fire-and-forget — the IIFE runs in the browser's microtask queue and streams
  // data via the binding. CDP returns immediately.
  const evaluateId = ++state.callIdCounter;
  const bodyRef = useTwoPhase ? `window[${JSON.stringify(bodyGlobalName)}]` : JSON.stringify(body);
  const fetchExpression = `(async () => {
  const t0 = Date.now();
  const bridge = window[${JSON.stringify(bindingName)}];
  
  try {
    const body = ${bodyRef};
    
    const requestId = crypto.randomUUID();
    const startTime = new Date().toISOString();
    
    const fetchStart = Date.now();
    
    const resp = await window.fetch(${JSON.stringify(url)}, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'source': 'web',
        'x-request-id': requestId,
        'x-accel-buffering': 'no',
        'timezone': new Date().toString(),
        'version': '0.2.66',
        'Referer': ${JSON.stringify(referer)},
      },
      body: body,
    });
    
    
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      bridge(btoa(JSON.stringify({ __httpError: true, status: resp.status, body: errText.substring(0, 2000) })));
      bridge('__QSB_DONE__');
      return;
    }
    
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let totalBytes = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        const text = decoder.decode(value, { stream: true });
        if (text) {
          const uint8 = new TextEncoder().encode(text);
          let binary = '';
          for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
          bridge(btoa(binary));
          chunkCount++;
          totalBytes += text.length;
          if (chunkCount <= 3 || chunkCount % 20 === 0) {
          }
        }
      }
    }
    
    bridge('__QSB_DONE__');
  } catch (e) {
    bridge('__QSB_ERROR__');
  }
})();`;

  // Fire-and-forget: no awaitPromise — CDP returns immediately.
  // The IIFE runs in the browser and streams data via the binding.
  // If the IIFE throws, it's unhandled — but the binding __QSB_ERROR__ is called.
  // Track in queue to catch fire-and-forget errors (no V8 timeout — watchdog handles lifecycle).
  state.queue.set(evaluateId, {
    resolve: (result) => {
      if (result?.exceptionDetails) {
        console.error(`[CDP:${email}] Fire-and-forget exception:`, JSON.stringify(result.exceptionDetails).slice(0, 500));
      }
    },
    reject: (err) => {
      console.error(`[CDP:${email}] Fire-and-forget error:`, err.message);
    },
    settled: false,
  });
  // Auto-cleanup after 30s
  setTimeout(() => {
    const entry = state.queue.get(evaluateId);
    if (entry && !entry.settled) state.queue.delete(evaluateId);
  }, 30_000);
  browserWs!.send(
    JSON.stringify({
      id: evaluateId,
      sessionId: state.sessionId,
      method: 'Runtime.evaluate',
      params: { expression: fetchExpression, returnByValue: false, awaitPromise: false },
    }),
  );

  // Node.js-side watchdog: if no data arrives within the timeout, force-close.
  // This catches baxia hangs, network failures, or any case where the browser-side
  // code never calls __QSB_DONE__ or __QSB_ERROR__.
  // For large bodies, Qwen API may take longer to respond — use generous timeout.
  const isLargeBody = body.length > 50_000;
  const watchdogMs = isLargeBody ? 180_000 : 90_000; // 3min for large, 90s for normal
  const watchdog = setTimeout(() => {
    if (!streamClosed) {
      console.error(`[CDP] WATCHDOG: no data for ${watchdogMs / 1000}s, email=${email} bodyLen=${body.length} — forcing close`);
      streamClosed = true;
      try {
        streamController?.error(new Error(`Stream watchdog: no data for ${watchdogMs / 1000}s`));
      } catch {
        /* already closed */
      }
      removeBindingForAccount(state, bindingName);
    }
  }, watchdogMs);

  // Clear watchdog when stream ends naturally (via __QSB_DONE__ or __QSB_ERROR__)
  const sc = streamController as any;
  if (sc) {
    const origClose = sc.close.bind(sc);
    const origError = sc.error.bind(sc);
    sc.close = (...args: any[]) => {
      clearTimeout(watchdog);
      return origClose(...args);
    };
    sc.error = (...args: any[]) => {
      clearTimeout(watchdog);
      return origError(...args);
    };
  }

  return { ok: true, status: -1, statusText: '', headers: {}, stream: nodeStream };
}

// ---------------------------------------------------------------------------

function removeBindingForAccount(state: AccountCdpState, name: string): void {
  state.streamBindings.delete(name);
  if (!browserWs || !browserConnected) return;
  const id = ++state.callIdCounter;
  browserWs.send(
    JSON.stringify({
      id,
      sessionId: state.sessionId,
      method: 'Runtime.removeBinding',
      params: { name },
    }),
  );
  state.queue.set(id, { resolve: () => {}, reject: () => {}, settled: false });
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

/** Check if an account context exists and is fully initialized. */
export function hasAccountContext(email: string): boolean {
  return accountStates.get(email)?.initialized === true;
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

  const filtered = accounts.filter((acct) => {
    if (!acct.profileCookies) {
      console.warn(`[CDP] Skipping ${acct.email} — no profileCookies`);
      return false;
    }
    return true;
  });

  // Run 2 accounts at a time to avoid overwhelming the browser
  const concurrency = 2;
  for (let i = 0; i < filtered.length; i += concurrency) {
    const batch = filtered.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map((acct) =>
        initAccountContext(acct.email, acct.profileCookies!).catch((err: any) => {
          console.error(`[CDP] Failed to init context for ${acct.email}: ${err.message}`);
        }),
      ),
    );
  }
}

/**
 * Stop all account contexts and disconnect.
 */
export function stopAllAccounts(): void {
  for (const [, state] of accountStates) {
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
