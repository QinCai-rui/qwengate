import crypto from 'crypto';
import { type Browser, type BrowserContext, type Cookie, type Page } from 'playwright';
import { logStore } from './logStore.ts';
import { QWEN_BX_V } from './qwen.ts';

export type { BrowserProfileOptions, LoginResult } from './browserProfiles.ts';
export { BROWSER_DEFAULT_ARGS, getProfileDir, openBrowserProfile, refreshViaProfile } from './browserProfiles.ts';

const QWEN_BASE_URL = 'https://chat.qwen.ai';
export interface AccountContext {
  context: BrowserContext;
  page: Page;
  lastRefresh: number;
  cookies: Record<string, string>;
  headers: Record<string, string>;
  refreshInterval?: NodeJS.Timeout;
}
const accountContexts = new Map<string, AccountContext>();
const contextCreationInFlight = new Map<string, Promise<AccountContext>>();
let defaultBrowser: any = null;
let cachedUserAgent: string | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function validateQwenUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Blocked URL protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '0.0.0.0') {
    throw new Error(`Blocked loopback URL: ${url}`);
  }
  if (
    /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
    /^192\.168\.\d+\.\d+$/.test(hostname)
  ) {
    throw new Error(`Blocked private IP URL: ${url}`);
  }
}
export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}
export async function getCookies(email?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  if (email) {
    const accCtx = accountContexts.get(email);
    if (accCtx) {
      const cookies = await accCtx.context.cookies();
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }
    // No context yet — inject saved profileCookies (full baxia/WAF session)
    // so even the first session creation request has a complete cookie set.
    try {
      const { getAccountByEmail } = await import('./auth.ts');
      const acct = getAccountByEmail(email);
      if (acct?.profileCookies) {
        // Strip any existing token= from profileCookies—the caller (getBasicHeaders)
        // will prepend the fresh JWT. Duplicate token cookies confuse some servers.
        const stripped = acct.profileCookies
          .replace(/\btoken=[^;]+;?\s*/g, '')
          .replace(/;+$/, '')
          .trim();
        return stripped;
      }
    } catch (importErr: any) {
      logStore.log('debug', 'playwright', `getCookies fallback import error: ${importErr.message}`);
    }
  }
  return '';
}
export interface BasicHeaders {
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUmidtoken: string;
  bxUa: string;
  email?: string;
}
export async function getBasicHeaders(email?: string): Promise<BasicHeaders> {
  if (process.env.TEST_MOCK_PLAYWRIGHT)
    return { cookie: 'token=mock', userAgent: 'mock', bxV: QWEN_BX_V, bxUmidtoken: '', bxUa: '', email: 'mock@test' };
  // Browserless mode: no Playwright needed for headers.
  // Cookies from saved profileCookies (disk), bx-ua from Node.js generator.
  if (!cachedUserAgent) {
    cachedUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  }
  let cookieStr = await getCookies(email);
  const { getTokenWithAccount } = await import('./auth.ts');
  const tokenInfo = await getTokenWithAccount(email);
  if (tokenInfo) {
    const tokenEntry = `token=${tokenInfo.token}`;
    cookieStr = tokenEntry + (cookieStr ? '; ' + cookieStr : '');
  }
  return {
    cookie: cookieStr,
    userAgent: cachedUserAgent,
    bxV: QWEN_BX_V,
    bxUmidtoken: '', // browserlessFetch fills this via ensureBxUmidtoken
    bxUa: '', // browserlessFetch fills this via generateBxUa
    email: tokenInfo?.email,
  };
}

function typedCast<T>(v: unknown): T {
  return v as T;
}

export async function createAccountContext(email: string, cookies?: Record<string, string>): Promise<AccountContext> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return {
      context: typedCast<BrowserContext>(null),
      page: typedCast<Page>(null),
      lastRefresh: Date.now(),
      cookies: cookies || {},
      headers: {},
    };
  }
  const existing = accountContexts.get(email);
  if (existing) return existing;
  const inFlight = contextCreationInFlight.get(email);
  if (inFlight) return inFlight;
  // Set before calling to prevent concurrent creations for the same email
  const creationPromise = createContextInternal(email, cookies);
  contextCreationInFlight.set(email, creationPromise);
  try {
    return await creationPromise;
  } finally {
    contextCreationInFlight.delete(email);
  }
}
async function createContextInternal(email: string, cookies?: Record<string, string>): Promise<AccountContext> {
  if (!defaultBrowser) throw new Error('Playwright browser not initialized');
  if (accountContexts.has(email)) return accountContexts.get(email)!;

  // Merge provided cookies with any saved profileCookies (full session with
  // baxia/WAF cookies: cna, ssxmod_itna, tfstk, isg, etc.)
  let allCookies = { ...cookies };
  try {
    const { getAccountByEmail } = await import('./auth.ts');
    const acct = getAccountByEmail(email);
    if (acct?.profileCookies) {
      acct.profileCookies.split(';').forEach((pair) => {
        const eq = pair.indexOf('=');
        if (eq > 0) {
          const name = pair.slice(0, eq).trim();
          const val = pair.slice(eq + 1).trim();
          if (name && val) allCookies[name] = val;
        }
      });
    }
  } catch (mergeErr: any) {
    logStore.log('debug', 'playwright', `profileCookies merge error: ${mergeErr.message}`);
  }

  const context = await defaultBrowser.newContext({
    storageState:
      allCookies && Object.keys(allCookies).length > 0
        ? {
            cookies: Object.entries(allCookies).map(
              ([name, value]) =>
                ({
                  name,
                  value,
                  domain: '.qwen.ai',
                  path: '/',
                  expires: Math.floor(Date.now() / 1000) + 3600,
                  httpOnly: true,
                  secure: true,
                  sameSite: 'Lax',
                }) as Cookie,
            ),
            origins: [],
          }
        : undefined,
  });
  const page = await context.newPage();
  const extractedHeaders: Record<string, string> = {};
  await page.route('**/api/**', async (route: any, request: any) => {
    const headers = request.headers();
    if (headers['bx-umidtoken']) extractedHeaders['bx-umidtoken'] = headers['bx-umidtoken'];
    if (headers['bx-ua']) extractedHeaders['bx-ua'] = headers['bx-ua'];
    if (headers['user-agent']) extractedHeaders['user-agent'] = headers['user-agent'];
    await route.continue();
  });
  await page.route('**/*', (route: any) => {
    const resourceType = route.request().resourceType();
    const url = route.request().url();
    if (resourceType === 'image' || resourceType === 'font' || resourceType === 'stylesheet' || resourceType === 'media') {
      route.abort();
    } else if (
      url.includes('google-analytics.com') ||
      url.includes('googletagmanager.com') ||
      url.includes('facebook.com') ||
      url.includes('hotjar.com') ||
      url.includes('sentry.io')
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });
  // Navigate the page to qwen.ai so baxia scripts load and generate real
  // bx-umidtoken/bx-ua headers. The Aliyun WAF may initially return a JS
  // challenge page (meta tags aliyun_waf_aa/bb) instead of the actual SPA.
  // We wait for the WAF challenge to resolve (JS executes, sets cookie, redirects)
  // and the SPA to fully load with baxia instrumentation.
  try {
    validateQwenUrl('https://chat.qwen.ai/');
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'load', timeout: 30000 });

    // Wait for either baxia to appear (SPA loaded) or up to 20s for the
    // WAF JS challenge to resolve and the SPA to render.
    for (let attempt = 0; attempt < 10; attempt++) {
      const hasBaxia = await page
        .evaluate(() => {
          const w = window as any;
          return !!(w.__baxia__ || w.baxia || w.baxiaFetchHandler);
        })
        .catch(() => false);

      if (hasBaxia) {
        // SPA loaded with baxia — give it a moment to hook into XHR
        await page.waitForTimeout(1000);
        break;
      }

      // Check if the page is still on the WAF challenge
      const isChallenged = await page
        .evaluate(() => document.documentElement?.innerHTML?.includes('aliyun_waf') ?? false)
        .catch(() => false);

      if (isChallenged) {
        // WAF challenge may need JS execution time. Wait and retry.
        logStore.log('debug', 'playwright', `WAF challenge page still showing, waiting... (attempt ${attempt + 1})`);
        await page.waitForTimeout(2000);
      } else {
        // Page loaded but baxia not available — might be a redirect or error page
        await page.waitForTimeout(2000);
      }
    }
  } catch (navErr: any) {
    logStore.log('debug', 'playwright', `Initial navigation to qwen.ai failed: ${navErr.message}`);
  }
  // NOTE: all cookies are already set via storageState above; no separate addCookies needed.
  // The merge order (cookies param + profileCookies) ensures the caller token takes priority.
  const accCtx: AccountContext = { context, page, lastRefresh: Date.now(), cookies: cookies || {}, headers: extractedHeaders };
  accountContexts.set(email, accCtx);
  accCtx.refreshInterval = setInterval(
    async () => {
      try {
        await refreshAccountCookies(email);
      } catch (err) {
        console.error(`[AccountContext] Refresh failed for ${email}:`, err);
      }
    },
    120_000 + Math.random() * 30000,
  );
  return accCtx;
}
export async function refreshAccountCookies(email: string): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  const accCtx = accountContexts.get(email);
  if (!accCtx) return;
  const { context, page } = accCtx;
  try {
    // Ensure the account's JWT token is injected as a cookie in the browser context
    const { getAccountByEmail } = await import('./auth.ts');
    const acct = getAccountByEmail(email);
    if (acct?.state?.token) {
      const existingCookies = await context.cookies();
      const hasTokenCookie = existingCookies.some((c) => c.name === 'token' && c.value === acct.state!.token);
      if (!hasTokenCookie) {
        await context.addCookies([
          {
            name: 'token',
            value: acct.state.token,
            domain: '.qwen.ai',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ]);
      }
    }

    const cookies = await context.cookies();
    const hasAuthCookie = cookies.some((c) => {
      const n = c.name.toLowerCase();
      if (n.includes('refresh')) return false;
      return n.includes('token') || n.includes('session');
    });
    if (!hasAuthCookie) {
      validateQwenUrl('https://chat.qwen.ai/');
      await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);
      const postCookies = await context.cookies();
      const hasPostAuth = postCookies.some((c) => {
        const n = c.name.toLowerCase();
        if (n.includes('refresh')) return false;
        return n.includes('token') || n.includes('session');
      });
      if (!hasPostAuth) {
        // Only throttle if we don't have a valid token in memory
        if (!acct?.state?.token || (acct.state.expiresAt && acct.state.expiresAt < Date.now())) {
          logStore.log('warn', 'account', `${email} has no auth cookie and no valid token - marking unavailable`);
          const { throttleAccount } = await import('./auth.ts');
          throttleAccount(email, 60_000);
        } else {
          logStore.log('info', 'account', `${email} has valid token in memory but no browser cookie - will use token directly`);
        }
        accCtx.cookies = {};
        accCtx.lastRefresh = Date.now();
        return;
      }
    }
    const freshCookies = await context.cookies();
    const cookieRecord: Record<string, string> = {};
    for (const c of freshCookies) {
      cookieRecord[c.name] = c.value;
    }
    accCtx.cookies = cookieRecord;
    accCtx.lastRefresh = Date.now();

    // Sync profileCookies with fresh context cookies for WAF bypass continuity.
    // Debounced: only save to disk if cookies actually changed.
    if (acct) {
      const freshProfileStr = freshCookies
        .filter((c: Cookie) => c.name && c.value)
        .map((c: Cookie) => `${c.name}=${c.value}`)
        .join('; ');
      if (freshProfileStr && freshProfileStr !== acct.profileCookies) {
        acct.profileCookies = freshProfileStr;
        // Fire-and-forget disk persistence (don't block the refresh cycle)
        const { saveAccountsToFile, accounts } = await import('./accountManager.ts');
        saveAccountsToFile(accounts);
      }
    }
  } catch (err) {
    console.error(`[AccountContext] Refresh error for ${email}:`, err);
  }
}
export function removeAccountContext(email: string): void {
  const accCtx = accountContexts.get(email);
  if (!accCtx) return;
  if (accCtx.refreshInterval) {
    clearInterval(accCtx.refreshInterval);
  }
  accCtx.context.close().catch(() => {});
  accountContexts.delete(email);
}

export function getActivePage(email?: string): Page | null {
  if (email) return accountContexts.get(email)?.page || null;
  for (const accCtx of accountContexts.values()) {
    return accCtx.page;
  }
  return null;
}
export function getBrowser(): Browser | null {
  return defaultBrowser || null;
}
export async function getQwenHeaders(
  email?: string,
): Promise<{ headers: Record<string, string>; chatSessionId: string; parentMessageId: string | null }> {
  // Browserless mode only — bx headers handled by browserlessFetch, skip CDP/Playwright
  return { headers: {}, chatSessionId: crypto.randomUUID(), parentMessageId: null };
}

// ---------------------------------------------------------------------------
// Browser-native fetch — routes HTTP requests through page.evaluate(fetch)
// inside the Playwright/Chrome browser. This uses the real Chrome TLS/HTTP2
// stack and automatically includes:
//   - Chrome JA3/JA4 fingerprint (undetectable by WAF)
//   - sec-ch-ua / sec-ch-ua-platform / sec-ch-ua-mobile client hints
//   - Real baxia bx-umidtoken / bx-ua headers
//   - All session cookies with proper domain/path isolation
// ---------------------------------------------------------------------------

/**
 * Ensure the account's browser page is at a valid SPA URL where baxia is active.
 * The SPA root is required because baxia scripts load with the initial HTML page.
 */
async function ensurePageAtSpaRoot(page: Page): Promise<void> {
  const currentUrl = page.url();
  try {
    const parsed = new URL(currentUrl);
    // Any chat.qwen.ai page with a path is OK — the SPA is a single-page app
    // and baxia hooks persist across client-side navigation.
    if (parsed.hostname === 'chat.qwen.ai' || parsed.hostname.endsWith('.qwen.ai')) {
      return;
    }
  } catch {}
  // Page is on about:blank or another origin — navigate to SPA root
  try {
    validateQwenUrl(QWEN_BASE_URL);
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'load', timeout: 30000 });

    // Wait for baxia or resolve WAF challenge (same retry loop as createContextInternal)
    for (let attempt = 0; attempt < 10; attempt++) {
      const hasBaxia = await page
        .evaluate(() => {
          const w = window as any;
          return !!(w.__baxia__ || w.baxia || w.baxiaFetchHandler);
        })
        .catch(() => false);
      if (hasBaxia) break;
      await page.waitForTimeout(2000);
    }
  } catch (navErr: any) {
    logStore.log('debug', 'playwright', `ensurePageAtSpaRoot navigation failed: ${navErr.message}`);
  }
}

/**
 * Make a non-streaming HTTP request through the account's browser page.
 *
 * Uses page.evaluate(fetch) to get the real Chrome TLS stack, automatic
 * sec-ch-ua client hints, and real baxia bx-* headers. The full response
 * (status, headers, body) is returned to the Node.js process.
 *
 * Suitable for: session create/delete, model fetches, settings, token refresh.
 */
export async function performBrowserFetch(
  email: string,
  url: string,
  options: { method: string; body?: string; timeout?: number },
): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; body: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    // In test mode, delegate to globalThis.fetch (mocked by the test).
    const resp = await fetch(url, {
      method: options.method,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body || undefined,
    });
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries()),
      body: await resp.text(),
    };
  }

  // CDP mode: route through the real Chrome browser (logged-in Qwen account).
  let accCtx = accountContexts.get(email);
  if (!accCtx) {
    const existingKeys = Array.from(accountContexts.keys());
    console.error(`[BROWSER_CTX_ERR] No context for ${email}. Existing contexts: ${existingKeys.join(', ') || 'NONE'}`);
    // Try to recover by calling getQwenHeaders to create a fresh context
    await getQwenHeaders(email);
    const recovered = accountContexts.get(email);
    if (!recovered) throw new Error(`No browser context for account ${email} (recovery failed)`);
    accCtx = recovered;
  }
  const { page } = accCtx;
  const timeout = options.timeout || 30000;
  await ensurePageAtSpaRoot(page);
  // Debug: check page actual content to see if SPA loaded or WAF challenge
  try {
    const pageInfo = await page.evaluate(() => ({
      url: location.href,
      hasBaxia: !!(window as any).__baxia__,
      hasBaxiaFetchHandler: typeof (window as any).baxiaFetchHandler !== 'undefined',
      docPrefix: (document.documentElement?.innerHTML || '').substring(0, 200),
    }));
    console.error(`[BROWSER_CTX] ${email}: url=${pageInfo.url} baxia=${pageInfo.hasBaxia} baxiaFH=${pageInfo.hasBaxiaFetchHandler}`);
    if (pageInfo.docPrefix.includes('aliyun_waf')) {
      console.error(`[BROWSER_CTX] ${email}: PAGE CONTENT IS WAF CHALLENGE`);
    }
  } catch (e: any) {
    console.error(`[BROWSER_CTX] ${email}: page.evaluate failed: ${e.message}`);
  }
  const result = await page.evaluate(
    async (opts: { url: string; method: string; body?: string; timeout: number }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeout);
      try {
        // Use XMLHttpRequest because baxia wraps XHR (not window.fetch) to
        // inject bx-umidtoken and bx-ua headers. Without these, the WAF
        // returns a meta-tag challenge page for certain API endpoints.
        const xhr = new XMLHttpRequest();
        const result = await new Promise<{
          ok: boolean;
          status: number;
          statusText: string;
          headers: Record<string, string>;
          body: string;
        }>((resolve, reject) => {
          xhr.open(opts.method, opts.url, true);
          xhr.withCredentials = true;
          if (opts.body) xhr.setRequestHeader('Content-Type', 'application/json');
          // Abort on signal
          if (controller.signal) {
            controller.signal.addEventListener('abort', () => {
              xhr.abort();
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }
          xhr.onload = () => {
            const headers: Record<string, string> = {};
            const headerStr = xhr.getAllResponseHeaders();
            headerStr.split('\r\n').forEach((line) => {
              const colon = line.indexOf(':');
              if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 2);
            });
            resolve({
              ok: xhr.status >= 200 && xhr.status < 300,
              status: xhr.status,
              statusText: xhr.statusText,
              headers,
              body: xhr.responseText,
            });
          };
          xhr.onerror = () => reject(new Error('XHR network error'));
          xhr.ontimeout = () => reject(new Error('XHR timeout'));
          xhr.timeout = opts.timeout;
          xhr.send(opts.body || null);
        });
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
    { url, method: options.method, body: options.body, timeout },
  );

  // Debug: log non-JSON responses and per-account page state
  if (!result.body.startsWith('{') && !result.body.startsWith('data:')) {
    console.error(
      `[BROWSER_FETCH_DEBUG] ${options.method} ${url} (account=${email}) -> ${result.status} (body=${result.body.substring(0, 400)})`,
    );
  }

  return result;
}
