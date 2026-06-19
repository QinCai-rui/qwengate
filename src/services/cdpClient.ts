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
  console.log(`[CDP] Connecting to browser WS: ${wsUrl}`);

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
      console.log('[CDP] Browser WS connected');
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

          // Other events with sessionId — capture bx headers
          if (msg.method === 'Network.requestWillBeSent' && state && msg.params?.request?.url?.includes('/api/v2/')) {
            const headers = msg.params.request.headers || {};
            if (headers['bx-umidtoken']) state.cachedBxHeaders['bx-umidtoken'] = headers['bx-umidtoken'];
            if (headers['bx-ua']) state.cachedBxHeaders['bx-ua'] = headers['bx-ua'];
            if (headers['bx-v']) state.cachedBxHeaders['bx-v'] = headers['bx-v'];
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

  console.log(`[CDP] Creating context for ${email}...`);

  // 1. Create browser context
  const ctxResult = await browserEvaluate<{ browserContextId: string }>('Target.createBrowserContext', {});
  const contextId = ctxResult.browserContextId;
  console.log(`[CDP]   contextId=${contextId}`);

  // 2. Create target (page) in that context
  const tgtResult = await browserEvaluate<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    browserContextId: contextId,
  });
  const targetId = tgtResult.targetId;
  console.log(`[CDP]   targetId=${targetId}`);

  // 3. Attach to target with flatten: true → get sessionId
  const attachResult = await browserEvaluate<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const sessionId = attachResult.sessionId;
  console.log(`[CDP]   sessionId=${sessionId}`);

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
  };
  accountStates.set(email, state);
  sessionToEmail.set(sessionId, email);

  if (!defaultAccountEmail) defaultAccountEmail = email;

  // 5. Enable Network domain for this session (required for Network.setCookie)
  await sendToAccount(state, 'Network.enable', {});
  await sendToAccount(state, 'Page.enable', {});
  console.log(`[CDP]   Network + Page enabled for ${email}`);

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
  console.log(`[CDP]   Stealth scripts injected for ${email}`);

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
    console.log(`[CDP]   Injected ${injected} cookies for ${email}`);
  }

  // 7. Navigate to chat.qwen.ai to load SPA + baxia
  await sendToAccount(state, 'Page.navigate', { url: 'https://chat.qwen.ai/' });
  console.log(`[CDP]   Navigating ${email} to chat.qwen.ai...`);

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
        console.log(`[CDP]   baxia ready for ${email} after ${waitMs + 2000}ms`);
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
    console.log(`[CDP]   baxia for ${email}: ${status.hasBaxia} | fetch wrapped: ${status.fetchIsWrapped}`);
  } catch (err: any) {
    console.warn(`[CDP]   baxia check failed for ${email}: ${err.message}`);
  }

  // 10. Enable Network tracking to capture bx headers
  // Network.enable already called above, trigger a fire-and-forget fetch
  triggerBxHeaderCaptureForAccount(state);
  await Bun.sleep(1500);

  console.log(`[CDP] Account context ready: ${email} (sessionId=${sessionId})`);
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
  console.log(`[CDP] Refreshing baxia for ${email}...`);
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
          console.log(`[CDP]   baxia refreshed for ${email} after ${waitMs + 2000}ms`);
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
  const { method = 'GET', body, timeout = 30000 } = options;

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
        params: { expression: storeExpression, returnByValue: true, timeout: 10_000 },
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
export async function browserStreamFetchIncrementalForAccount(
  email: string,
  url: string,
  body: string,
  options?: { referer?: string; timeout?: number },
): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }> {
  const state = accountStates.get(email);
  if (!state) throw new Error(`No CDP context for account ${email}`);

  const referer = options?.referer || 'https://chat.qwen.ai/';
  const timeout = options?.timeout || 60_000;
  const bindingName = `__cdp_sb_${++state.callIdCounter}_${Date.now()}`;
  const startTime = Date.now();
  console.log(`[CDP] streamFetch start: email=${email} url=${url.slice(0, 80)} binding=${bindingName} bodyLen=${body.length}`);

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
      console.log(`[CDP] stream DONE: ${Date.now() - startTime}ms total, ${chunkCount} chunks, email=${email}`);
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
      console.log(`[CDP] first chunk: ${firstChunkTime - startTime}ms, email=${email}`);
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
    console.log(`[CDP] Large body (${(body.length / 1024).toFixed(0)}KB) — using two-phase storage for email=${email}`);
    // Phase 1: Store body in browser global (simple assignment, no baxia involvement)
    const storeId = ++state.callIdCounter;
    const storeExpression = `window[${JSON.stringify(bodyGlobalName)}] = ${JSON.stringify(body)}; 'ok'`;
    browserWs!.send(
      JSON.stringify({
        id: storeId,
        sessionId: state.sessionId,
        method: 'Runtime.evaluate',
        params: { expression: storeExpression, returnByValue: true, timeout: 10_000 },
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
    console.log(`[CDP] Body stored in browser global: ${Date.now() - startTime}ms`);
  }

  // Launch fetch in the account's page (fire-and-forget) using window.fetch()
  // so baxia's wrapper intercepts and injects bx-umidtoken/bx-ua headers.
  const evaluateId = ++state.callIdCounter;
  const bodyRef = useTwoPhase ? `window[${JSON.stringify(bodyGlobalName)}]` : JSON.stringify(body);
  const fetchExpression = `(async () => {
    const bridge = window[${JSON.stringify(bindingName)}];
    try {
      const requestId = crypto.randomUUID();
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
        body: ${bodyRef},
      });
      console.log('[CDP-BROWSER] fetch completed: status=' + resp.status + ' ok=' + resp.ok);

      if (!resp.ok || resp.status < 200 || resp.status >= 300) {
        const errText = await resp.text().catch(() => '');
        console.error('[CDP-BROWSER] HTTP error:', resp.status, resp.statusText, errText.slice(0, 300));
        const errPayload = JSON.stringify({ __httpError: true, status: resp.status, body: errText });
        const uint8 = new TextEncoder().encode(errPayload);
        let binary = '';
        for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
        bridge(btoa(binary));
        bridge('__QSB_DONE__');
        return { ok: false, status: resp.status };
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
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
          }
        }
      }
      bridge('__QSB_DONE__');
      return { ok: true, status: resp.status };
    } catch(e) {
      console.error('[CDP-BROWSER] fetch error:', e.message, e.name, e.constructor?.name);
      bridge('__QSB_ERROR__');
      return { ok: false, error: e.message };
    }
  })()`;

  // Register the eval completion so errors don't leak
  browserWs!.send(
    JSON.stringify({
      id: evaluateId,
      sessionId: state.sessionId,
      method: 'Runtime.evaluate',
      params: { expression: fetchExpression, returnByValue: true, awaitPromise: true, timeout },
    }),
  );
  state.queue.set(evaluateId, {
    resolve: () => {},
    reject: () => {
      console.error(`[CDP] evaluate REJECTED: ${Date.now() - startTime}ms, email=${email}`);
      if (!streamClosed) {
        streamClosed = true;
        streamController?.error(new Error('CDP fetch evaluate failed'));
        removeBindingForAccount(state, bindingName);
      }
      // Clean up browser global
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
    },
    settled: false,
  });

  return { ok: true, status: -1, statusText: '', headers: {}, stream: nodeStream };
}

// ---------------------------------------------------------------------------
// Cleanup helpers
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

/** Check if an account context exists. */
export function hasAccountContext(email: string): boolean {
  return accountStates.has(email);
}

/** Get all initialized account emails. */
export function getAccountEmails(): string[] {
  return Array.from(accountStates.keys());
}

/**
 * Initialize the browser connection and all account contexts.
 * Call once at startup after startBrowser().
 */
export async function initAllAccountContexts(accounts: Array<{ email: string; profileCookies?: string }>): Promise<void> {
  await connectBrowserWs();
  console.log(`[CDP] Initializing ${accounts.length} account contexts...`);

  for (const acct of accounts) {
    if (!acct.profileCookies) {
      console.warn(`[CDP] Skipping ${acct.email} — no profileCookies`);
      continue;
    }
    try {
      await initAccountContext(acct.email, acct.profileCookies);
    } catch (err: any) {
      console.error(`[CDP] Failed to init context for ${acct.email}: ${err.message}`);
    }
  }

  console.log(`[CDP] Account contexts ready: ${getAccountEmails().join(', ')}`);
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
