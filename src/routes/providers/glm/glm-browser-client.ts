/**
 * GLM Browser Client — persistent Chromium for signature computation.
 *
 * Strategy:
 *   1. Loads the z.ai page with JS bundle interception to expose _re to window
 *   2. The running app's _re function computes correct x-signatures
 *   3. Cookies are extracted from the browser context (real WAF cookies)
 *   4. Full GLM API requests can be proxied through the browser
 */

import { createHmac } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
import { getGlmCookieString, setGlmCookieValue } from '../../../services/glmCookieManager.ts';
import { logStore } from '../../../services/logStore.ts';

const TAG = 'glm-browser';
const GLM_BASE_URL = 'https://chat.z.ai';
const JS_BUNDLE_PATTERN = '**/assets/index-*.js';

// ─── Browser lifecycle ────────────────────────────────────────────────────────

let browser: Browser | null = null;
let page: Page | null = null;
let startupPromise: Promise<void> | null = null;
let hasSignatureEngine = false;

const MINIMAL_ARGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-translate',
  '--disable-sync',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-domain-reliability',
  '--disable-component-extensions-with-background-pages',
  '--disable-features=TranslateUI,IsolateOrigins,site-per-process,BackForwardCache',
  '--no-first-run',
  '--no-default-browser-check',
  '--metrics-recording-only',
  '--mute-audio',
  '--window-size=1,1',
];

function findChromiumBinary(): string | null {
  const systemBin = '/run/current-system/sw/bin/chromium';
  if (existsSync(systemBin)) return systemBin;
  const pwDir = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(pwDir)) {
    const dirs = readdirSync(pwDir).filter((d) => d.startsWith('chromium-'));
    dirs.sort().reverse();
    for (const d of dirs) {
      const c1 = join(pwDir, d, 'chrome-linux', 'chrome');
      if (existsSync(c1)) return c1;
      const c2 = join(pwDir, d, 'chrome');
      if (existsSync(c2)) return c2;
    }
  }
  return null;
}

/**
 * Ensure the persistent browser is alive and the z.ai JS engine is loaded.
 */
async function ensureBrowser(): Promise<void> {
  if (browser?.isConnected() && page && hasSignatureEngine) return;
  if (startupPromise) {
    await startupPromise;
    return;
  }

  startupPromise = (async () => {
    logStore.log('info', TAG, 'Launching Chromium with z.ai signature engine...');
    const startMs = Date.now();

    const chromeBin = findChromiumBinary();
    const launchOpts: any = { headless: true, args: MINIMAL_ARGS };
    if (chromeBin) launchOpts.executablePath = chromeBin;

    const b = await chromium.launch(launchOpts);
    const p = await b.newPage();

    // Intercept the JS bundle: expose _re to window via regex replacement
    await p.route(JS_BUNDLE_PATTERN, async (route) => {
      try {
        const response = await route.fetch();
        let body = await response.text();
        const url = route.request().url();
        logStore.log('debug', TAG, `Intercepted bundle: ${url.split('/').pop()}`);

        // Target the arrow-function definition: `_re=(t,e,r)=>{...}`
        // Replace it with `window.__glm_re=_re=(t,e,r)=>{...}` so the module-scoped
        // _re also becomes a global property.
        const injectedBody = body.replace(/([;,)}\]])(_re=\s*\(t,e,r\)\s*=>)/g, (m, prefix, rest) => {
          return prefix + 'window.__glm_re=' + rest;
        });
        const wasInjected = injectedBody !== body;
        if (wasInjected) {
          body = injectedBody;
          logStore.log('info', TAG, `Injected __glm_re into bundle`);
        } else {
          // Fallback: append at end of bundle
          body = body + `\n;try{window.__glm_re=typeof _re!=='undefined'?_re:null}catch(e){};\n`;
          logStore.log('warn', TAG, 'Fallback: appending _re expose at end of bundle');
        }

        await route.fulfill({ status: response.status(), headers: response.headers(), body });
      } catch (err: any) {
        logStore.log('warn', TAG, `Route intercept failed: ${err.message}`);
        await route.continue();
      }
    });

    // Block media/image to save memory
    await p.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'stylesheet', 'media', 'websocket', 'manifest'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // Load the z.ai page — this triggers the JS bundle to execute
    await p.goto(GLM_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait up to 15 seconds for the signature engine to be available
    try {
      await p.waitForFunction(() => typeof (window as any).__glm_re === 'function', { timeout: 15_000 });
      hasSignatureEngine = true;
      logStore.log('info', TAG, 'z.ai signature engine loaded');
    } catch {
      logStore.log('warn', TAG, 'Signature engine not available');
      hasSignatureEngine = false;
    }

    browser = b;
    page = p;

    const elapsed = Date.now() - startMs;
    logStore.log('info', TAG, `Browser ready in ${elapsed}ms`);
  })()
    .catch((err) => {
      logStore.log('error', TAG, `Launch failed: ${err.message}`);
      browser = null;
      page = null;
      hasSignatureEngine = false;
      throw err;
    })
    .finally(() => {
      startupPromise = null;
    });

  await startupPromise;
}

// ─── Cookie extraction ────────────────────────────────────────────────────────

/**
 * Extract fresh cookies from the browser context.
 * Returns a cookie string suitable for use in wreqFetch requests.
 */
export async function extractGlmCookies(): Promise<string> {
  await ensureBrowser();
  if (!browser || !page) return '';

  try {
    const context = page.context();
    const cookies = await context.cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    logStore.log('debug', TAG, `Extracted ${cookies.length} cookies from browser`);
    return cookieStr;
  } catch (err: any) {
    logStore.log('warn', TAG, `Cookie extraction failed: ${err.message}`);
    return '';
  }
}

// ─── Signature computation ────────────────────────────────────────────────────

let cachedSignature: { signature: string; timestamp: string; expiresAt: number } | null = null;

/**
 * Compute x-signature using z.ai's own _re function running in the browser.
 * Falls back to Node.js HMAC-SHA256 if the browser engine is unavailable.
 */
export async function computeGlmSignature(
  sortedPayload: string,
  messageContent: string,
  timestamp: string,
): Promise<{ signature: string; timestamp: string }> {
  // Check cache first (5-minute TTL matching the time bucket)
  if (cachedSignature && cachedSignature.expiresAt > Date.now()) {
    return { signature: cachedSignature.signature, timestamp: cachedSignature.timestamp };
  }

  try {
    await ensureBrowser();
  } catch {
    return computeFallbackSignature(sortedPayload, messageContent, timestamp);
  }

  if (page && hasSignatureEngine) {
    try {
      const result = await page.evaluate(
        async (args: { sortedPayload: string; messageContent: string; timestamp: string }) => {
          const w = window as any;
          if (typeof w.__glm_re !== 'function') return null;
          try {
            return w.__glm_re(args.sortedPayload, args.messageContent, args.timestamp);
          } catch {
            return null;
          }
        },
        { sortedPayload, messageContent, timestamp },
      );

      if (result && result.signature) {
        logStore.log('debug', TAG, 'Signature computed via browser _re engine');
        cachedSignature = {
          signature: result.signature,
          timestamp: result.timestamp,
          expiresAt: Date.now() + 4 * 60 * 1000,
        };
        return { signature: result.signature, timestamp: result.timestamp };
      }
    } catch (err: any) {
      logStore.log('warn', TAG, `Browser signature failed: ${err.message}`);
    }
  }

  return computeFallbackSignature(sortedPayload, messageContent, timestamp);
}

function computeFallbackSignature(
  sortedPayload: string,
  messageContent: string,
  timestamp: string,
): { signature: string; timestamp: string } {
  logStore.log('warn', TAG, 'Using Node.js HMAC-SHA256 fallback');
  const ts = Number(timestamp);
  const timeBucket = String(Math.floor(ts / 300000));
  const messageBase64 = Buffer.from(messageContent, 'utf-8').toString('base64');
  const message = `${sortedPayload}|${messageBase64}|${timestamp}`;
  const signature = createHmac('sha256', timeBucket).update(message).digest('hex');
  return { signature, timestamp };
}

// ─── Full proxy request ───────────────────────────────────────────────────────

export interface BrowserFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface BrowserFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  text: string;
}

/**
 * Make an HTTP request through the persistent Chromium browser.
 * Uses the browser's native fetch with correct headers and x-signature.
 */
export async function glmBrowserFetch(request: BrowserFetchRequest): Promise<BrowserFetchResponse> {
  const { url, method = 'GET', headers = {}, body, timeoutMs = 60_000 } = request;

  await ensureBrowser();
  if (!page) throw new Error('GLM browser not initialized');

  // Add x-signature if this is a chat completion request
  let finalHeaders = { ...headers };
  if (url.includes('/api/v2/chat/completions') && !finalHeaders['x-signature']) {
    const urlObj = new URL(url);
    const params = urlObj.searchParams;
    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const ts = params.get('timestamp') || String(Date.now());
    const sigResult = await computeGlmSignature(sortedParams, body || '', ts);
    finalHeaders['x-signature'] = sigResult.signature;
  }

  const result = await page.evaluate(
    async (opts: { url: string; method: string; headers: Record<string, string>; body: string | null; timeoutMs: number }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);

      try {
        const init: RequestInit = {
          method: opts.method,
          headers: opts.headers,
          signal: controller.signal,
          redirect: 'follow',
        };
        if (opts.body) init.body = opts.body;

        const res = await fetch(opts.url, init);
        const text = await res.text();

        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key] = value;
        });

        return { ok: res.ok, status: res.status, statusText: res.statusText, headers, text };
      } finally {
        clearTimeout(timeoutId);
      }
    },
    { url, method, headers: finalHeaders, body: body || null, timeoutMs },
  );

  return result;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

export async function shutdownGlmBrowser(): Promise<void> {
  cachedSignature = null;
  if (page) {
    try {
      await page.close();
    } catch {
      /* best effort */
    }
    page = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* best effort */
    }
    browser = null;
  }
  hasSignatureEngine = false;
  startupPromise = null;
  logStore.log('info', TAG, 'Browser shut down');
}

export function isGlmBrowserAlive(): boolean {
  return !!browser?.isConnected();
}
