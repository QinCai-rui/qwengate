/**
 * Lightweight CDP client that connects to an existing Chrome instance
 * and routes API calls through the browser's real network stack.
 *
 * This gives us:
 *   - Real Chrome TLS/HTTP2 fingerprint (undetectable by WAF)
 *   - Automatic sec-ch-ua headers
 *   - Automatic baxia bx-* headers (baxia wraps window.fetch)
 *   - All session cookies via credentials: 'include'
 *
 * Usage: set CHROME_CDP_ENDPOINT=http://127.0.0.1:9222
 *        Call initCdpClient() on startup, then browserFetch() etc.
 *
 * IMPORTANT: baxia wraps window.fetch (not XMLHttpRequest).
 * All API calls MUST use fetch() from the page context.
 */

const CDP_ENDPOINT = process.env.CHROME_CDP_ENDPOINT || 'http://127.0.0.1:26404';

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

let qwenPageWsUrl: string | null = null;
let cdpWs: WebSocket | null = null;
let cdpConnected = false;
let cdpQueue = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void; settled: boolean }>();
let callIdCounter = 0;
/** Captured bx headers from SPA network events */
let cachedBxHeaders: Record<string, string> = {};

/**
 * Streaming bridge: maps binding names to their chunk handlers.
 * When the browser calls `window[bindingName](chunk)`, CDP fires a
 * `Runtime.bindingCalled` event which we route here.
 */
const streamBindings = new Map<string, (chunk: string) => void>();

async function findQwenPage(): Promise<CdpPage> {
  const resp = await fetch(`${CDP_ENDPOINT}/json`);
  const targets: any[] = await resp.json();
  let qwenPage = targets.find((t: any) => t.type === 'page' && (t.title?.includes('Qwen') || t.url?.includes('chat.qwen.ai')));

  // If no Qwen page exists (auto-launched headless Chrome starts with about:blank),
  // return the first page — initCdpClient() will navigate it to chat.qwen.ai
  if (!qwenPage) {
    qwenPage = targets.find((t: any) => t.type === 'page');
    if (qwenPage) {
      console.log('[cdp] No Qwen page found, will navigate', qwenPage.url, '-> chat.qwen.ai');
    }
  }

  if (!qwenPage) throw new Error('No page found in browser. Launch Chrome with a page open.');
  return { id: qwenPage.id, webSocketDebuggerUrl: qwenPage.webSocketDebuggerUrl, url: qwenPage.url, title: qwenPage.title };
}

/** Ensure a persistent CDP WebSocket connection exists. */
async function connectCdp(): Promise<void> {
  if (cdpConnected && cdpWs) return;
  if (!qwenPageWsUrl) {
    const page = await findQwenPage();
    qwenPageWsUrl = page.webSocketDebuggerUrl;
  }
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(qwenPageWsUrl!);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP connect timeout'));
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timeout);
      cdpWs = ws;
      cdpConnected = true;
      resolve();
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string);
        // Capture bx headers from SPA network requests
        if (msg.method === 'Network.requestWillBeSent' && msg.params?.request?.url?.includes('/api/v2/')) {
          const headers = msg.params.request.headers || {};
          if (headers['bx-umidtoken']) cachedBxHeaders['bx-umidtoken'] = headers['bx-umidtoken'];
          if (headers['bx-ua']) cachedBxHeaders['bx-ua'] = headers['bx-ua'];
          if (headers['bx-v']) cachedBxHeaders['bx-v'] = headers['bx-v'];
        }
        // Route streaming bridge chunks from Runtime.addBinding
        if (msg.method === 'Runtime.bindingCalled' && msg.params?.name) {
          const handler = streamBindings.get(msg.params.name);
          if (handler) handler(msg.params.payload);
          return;
        }
        if (!msg.id) return; // event, not response
        const pending = cdpQueue.get(msg.id);
        if (!pending || pending.settled) return;
        pending.settled = true;
        cdpQueue.delete(msg.id);
        if (msg.error) pending.reject(new Error(`CDP: ${msg.error.message}`));
        else if (msg.result?.exceptionDetails) pending.reject(new Error(`CDP exception: ${msg.result.exceptionDetails.text}`));
        else pending.resolve(msg.result?.result?.value ?? msg.result ?? true);
      } catch {
        /* non-JSON event */
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      cdpConnected = false;
      reject(new Error('CDP WS error'));
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      cdpConnected = false;
      cdpWs = null;
      for (const [id, pending] of cdpQueue) {
        if (!pending.settled) {
          pending.settled = true;
          pending.reject(new Error('CDP WS disconnected'));
        }
        cdpQueue.delete(id);
      }
    };
  });
}

/** Execute a JS expression in the browser page and return the result. */
function evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
  return new Promise<T>(async (resolve, reject) => {
    try {
      await connectCdp();
    } catch (e: any) {
      return reject(new Error(`CDP connect: ${e.message}`));
    }
    const id = ++callIdCounter;
    const timeout = setTimeout(() => {
      const pending = cdpQueue.get(id);
      if (pending && !pending.settled) {
        pending.settled = true;
        cdpQueue.delete(id);
        reject(new Error('CDP evaluate timed out'));
      }
    }, 30000);

    cdpQueue.set(id, { resolve, reject, settled: false });
    cdpWs!.send(
      JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise, timeout: 25000 } }),
    );
  });
}

/**
 * Make a non-streaming API call through the browser.
 * Uses fetch() (not XHR) because baxia wraps fetch to inject bx-umidtoken/bx-ua headers.
 * Includes all headers the SPA sends to avoid WAF detection.
 */
export async function browserFetch(url: string, options: { method?: string; body?: string; timeout?: number } = {}): Promise<CdpResponse> {
  const { method = 'GET', body, timeout = 30000 } = options;
  const bodyClause = body ? `body: ${JSON.stringify(body)},` : '';
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
      return { ok: resp.ok, status: resp.status, statusText: resp.statusText, body: await resp.text(), headers };
    } catch(e) {
      return { ok: false, status: 0, statusText: e.message || 'NetworkError', body: '', headers: {} };
    }
  })()`;
  return evaluate<CdpResponse>(expression, true);
}

/**
 * Make a streaming API call through the browser.
 * Collects the full SSE body via fetch().text() and returns it.
 * Uses the same SPA headers as browserFetch.
 */
export async function browserStreamFetch(url: string, body: string, options?: { referer?: string }): Promise<CdpResponse> {
  const referer = options?.referer || 'https://chat.qwen.ai/';
  const expression = `(async () => {
    try {
      const requestId = crypto.randomUUID();
      const resp = await fetch(${JSON.stringify(url)}, {
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
        body: ${JSON.stringify(body)},
      });
      const headers = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      return { ok: resp.ok, status: resp.status, statusText: resp.statusText, body: await resp.text(), headers };
    } catch(e) {
      return { ok: false, status: 0, statusText: e.message || 'NetworkError', body: '', headers: {} };
    }
  })()`;
  return evaluate<CdpResponse>(expression, true);
}

/**
 * Incrementally stream an API response through the browser.
 * Uses Runtime.addBinding + XHR onprogress to pipe chunks back in real time,
 * identical to the Playwright exposeFunction approach but over raw CDP.
 *
 * Returns { ok, status, headers, stream } where stream delivers SSE text incrementally.
 */
export async function browserStreamFetchIncremental(
  url: string,
  body: string,
  options?: { referer?: string; timeout?: number },
): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }> {
  const referer = options?.referer || 'https://chat.qwen.ai/';
  const timeout = options?.timeout || 60_000;
  const bindingName = `__cdp_sb_${++callIdCounter}_${Date.now()}`;

  await connectCdp();

  // Register binding: browser calls window[bindingName](b64chunk)
  const addBindingId = ++callIdCounter;
  cdpWs!.send(
    JSON.stringify({
      id: addBindingId,
      method: 'Runtime.addBinding',
      params: { name: bindingName },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime.addBinding timeout')), 5000);
    cdpQueue.set(addBindingId, {
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
      removeBinding(bindingName);
    },
  });

  // Wire the binding to the stream controller.
  // All controller operations are guarded by `streamClosed` AND try-catch
  // to handle races where cancel() fires while a binding callback is in-flight.
  streamBindings.set(bindingName, (payload: string) => {
    if (streamClosed) return;
    if (payload === '__QSB_DONE__') {
      streamClosed = true;
      try {
        streamController?.close();
      } catch {
        /* already closed by cancel */
      }
      removeBinding(bindingName);
      return;
    }
    if (payload === '__QSB_ERROR__') {
      streamClosed = true;
      try {
        streamController?.error(new Error('Browser stream fetch failed'));
      } catch {
        /* already closed */
      }
      removeBinding(bindingName);
      return;
    }
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

  // Launch fetch in the browser (fire-and-forget) using window.fetch()
  // so baxia's fetch wrapper intercepts it and injects bx-umidtoken/bx-ua headers.
  // XHR is NOT wrapped by baxia — only fetch is. (see cdpClient.ts header comment)
  const evaluateId = ++callIdCounter;
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
        body: ${JSON.stringify(body)},
      });

      // Check HTTP status before streaming
      if (!resp.ok || resp.status < 200 || resp.status >= 300) {
        const errText = await resp.text().catch(() => '');
        const errPayload = JSON.stringify({ __httpError: true, status: resp.status, body: errText });
        const uint8 = new TextEncoder().encode(errPayload);
        let binary = '';
        for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
        bridge(btoa(binary));
        bridge('__QSB_DONE__');
        return { ok: false, status: resp.status };
      }

      // Stream response body incrementally via ReadableStream reader
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
      bridge('__QSB_ERROR__');
      return { ok: false, error: e.message };
    }
  })()`;

  // Register the eval completion so errors don't leak
  cdpWs!.send(
    JSON.stringify({
      id: evaluateId,
      method: 'Runtime.evaluate',
      params: { expression: fetchExpression, returnByValue: true, awaitPromise: true, timeout },
    }),
  );
  cdpQueue.set(evaluateId, {
    resolve: () => {},
    reject: () => {
      if (!streamClosed) {
        streamClosed = true;
        streamController?.error(new Error('CDP fetch evaluate failed'));
        removeBinding(bindingName);
      }
    },
    settled: false,
  });

  // Return immediately — the stream will deliver chunks as they arrive.
  // The caller must read the first chunk to determine HTTP status.
  return { ok: true, status: -1, statusText: '', headers: {}, stream: nodeStream };
}

/** Remove a Runtime.addBinding registration. */
function removeBinding(name: string): void {
  streamBindings.delete(name);
  if (!cdpWs || !cdpConnected) return;
  const id = ++callIdCounter;
  cdpWs.send(JSON.stringify({ id, method: 'Runtime.removeBinding', params: { name } }));
  cdpQueue.set(id, { resolve: () => {}, reject: () => {}, settled: false });
}

export async function checkBaxiaStatus(): Promise<{ hasBaxia: boolean; fetchIsWrapped: boolean }> {
  return evaluate('({hasBaxia:!!window.__baxia__,fetchIsWrapped:!fetch.toString().includes("native")})', false);
}

/**
 * Initialize CDP connection: inject saved cookies, navigate to chat.qwen.ai.
 * Safe to call multiple times — only runs once via singleton guard.
 */
let initInFlight: Promise<void> | null = null;
export async function initCdpClient(): Promise<void> {
  if (cdpConnected && cdpWs) return;
  if (initInFlight) {
    await initInFlight;
    return;
  }
  initInFlight = (async () => {
    const page = await findQwenPage();
    qwenPageWsUrl = page.webSocketDebuggerUrl;

    // Connect persistent WS
    await connectCdp();
    console.log('[cdp] Connected to browser');

    // Inject cookies from accounts.json via Network.setCookie
    try {
      const { readFileSync } = await import('node:fs');
      const { projectPath } = await import('../utils/paths.ts');
      const raw = readFileSync(projectPath('.qwen', 'accounts.json'), 'utf-8');
      const accounts: any[] = JSON.parse(raw);
      const acct = accounts.find((a: any) => a?.profileCookies);
      if (acct?.profileCookies) {
        const pairs = acct.profileCookies.split(';');
        let setCid = 0;
        for (const pair of pairs) {
          const eq = pair.indexOf('=');
          if (eq <= 0) continue;
          const name = pair.slice(0, eq).trim();
          const val = pair.slice(eq + 1).trim();
          if (!name || !val) continue;
          setCid++;
          cdpWs!.send(
            JSON.stringify({
              id: setCid,
              method: 'Network.setCookie',
              params: { name, value: val, domain: '.qwen.ai', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
            }),
          );
          cdpQueue.set(setCid, { resolve: () => {}, reject: () => {}, settled: false });
        }
        console.log('[cdp] Cookies injected');
      }
    } catch (err: any) {
      console.warn('[cdp] Cookie injection:', err.message);
    }

    // Always navigate to chat.qwen.ai so baxia loads (including auto-launched headless Chrome)
    const currentUrl = qwenPageWsUrl ? '' : '';
    try {
      let navId = 1000;
      cdpWs!.send(
        JSON.stringify({
          id: navId,
          method: 'Page.navigate',
          params: { url: 'https://chat.qwen.ai/' },
        }),
      );
      cdpQueue.set(navId, { resolve: () => {}, reject: () => {}, settled: false });
      console.log('[cdp] Navigating to chat.qwen.ai...');
      await new Promise((r) => setTimeout(r, 5000));
    } catch (err: any) {
      console.warn('[cdp] Navigation:', err.message);
    }

    // Verify baxia
    try {
      const status = await checkBaxiaStatus();
      console.log('[cdp] baxia:', status.hasBaxia, '| fetch wrapped:', status.fetchIsWrapped);
      if (!status.hasBaxia) console.warn('[cdp] baxia not detected');
    } catch (err: any) {
      console.warn('[cdp] baxia check failed:', err.message);
    }

    // Enable network tracking to capture bx headers from SPA requests
    await enableNetworkTracking();
    // Trigger a fire-and-forget fetch so baxia generates bx headers in network events
    triggerBxHeaderCapture();
    await new Promise((r) => setTimeout(r, 2000));
  })().finally(() => {
    initInFlight = null;
  });
}

function enableNetworkTracking(): Promise<void> {
  return new Promise<void>((resolve) => {
    cdpWs!.send(JSON.stringify({ id: ++callIdCounter, method: 'Network.enable', params: {} }));
    cdpQueue.set(callIdCounter, { resolve: () => resolve(), reject: () => resolve(), settled: false });
  });
}

/**
 * Fire-and-forget fetch from the SPA page to trigger baxia's
 * fetch wrapper. The bx headers are captured via Network.requestWillBeSent
 * events on the persistent CDP WebSocket.
 */
function triggerBxHeaderCapture(): void {
  const id = ++callIdCounter;
  cdpWs!.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        expression: `fetch("https://chat.qwen.ai/api/v2/models", {credentials:"include",headers:{"Accept":"application/json","source":"web"}}).catch(()=>{})`,
        returnByValue: true,
        awaitPromise: false,
        timeout: 5000,
      },
    }),
  );
  cdpQueue.set(id, { resolve: () => {}, reject: () => {}, settled: false });
}
