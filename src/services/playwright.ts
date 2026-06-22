import { launch as cloakLaunch } from 'cloakbrowser';
import crypto from 'crypto';
import { Browser, BrowserContext, Cookie, chromium, firefox, Page, webkit } from 'playwright';
import { logStore } from './logStore.ts';
import { QWEN_BX_V } from './qwen.ts';

export type { BrowserProfileOptions, LoginResult } from './browserProfiles.ts';
export { BROWSER_DEFAULT_ARGS, getProfileDir, openBrowserProfile, refreshViaProfile } from './browserProfiles.ts';

const QWEN_BASE_URL = 'https://chat.qwen.ai';
export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';
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
let initInFlight: Promise<void> | null = null;
let cachedUserAgent: string | null = null;
let cachedCookies: string | null = null;
let lastCookiesTime = 0;
const COOKIES_TTL = 30 * 1000;
let cookiesInFlight: Promise<string> | null = null;
const COOKIE_REFRESH_INTERVAL = 120 * 1000;
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
    return '';
  }
  if (cachedCookies && Date.now() - lastCookiesTime < COOKIES_TTL) {
    return cachedCookies;
  }
  if (cookiesInFlight) return cookiesInFlight;
  cookiesInFlight = (async () => {
    if (cachedCookies && Date.now() - lastCookiesTime < COOKIES_TTL) {
      return cachedCookies;
    }
    const allCookieStrings: string[] = [];
    for (const accCtx of accountContexts.values()) {
      const cookies = await accCtx.context.cookies();
      allCookieStrings.push(cookies.map((c) => `${c.name}=${c.value}`).join('; '));
    }
    cachedCookies = allCookieStrings.join('; ');
    lastCookiesTime = Date.now();
    return cachedCookies;
  })().finally(() => {
    cookiesInFlight = null;
  });
  return cookiesInFlight;
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
  // CDP mode: browser handles all headers automatically
  if (process.env.CHROME_CDP_ENDPOINT) {
    const { pickAccount, decrementInFlight } = await import('./auth.ts');
    const acct = email ? { email } : await pickAccount();
    const result = { cookie: '', userAgent: '', bxV: QWEN_BX_V, bxUmidtoken: '', bxUa: '', email: acct?.email || '' };
    if (!email && acct?.email) decrementInFlight(acct.email);
    return result;
  }
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
export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (defaultBrowser) return;
  if (initInFlight) {
    await initInFlight;
    return;
  }
  initInFlight = (async () => {
    if (defaultBrowser) return;

    // CDP connection mode: route through existing Chrome via our own CDP
    // client (cdpClient.ts) instead of Playwright's connectOverCDP, which
    // hangs on Chromium 148+. Playwright is NOT used for CDP mode at all —
    // performBrowserFetch/performBrowserStream use cdpClient.ts directly.
    const cdpEndpoint = process.env.CHROME_CDP_ENDPOINT;
    if (cdpEndpoint) {
      logStore.log('info', 'playwright', `CDP mode: using cdpClient.ts for ${cdpEndpoint}`);
      // Skip Playwright entirely — cdpClient.ts handles browser connection
      return;
    }

    let browserEngine: any;
    let channel: string | undefined;
    switch (browserType) {
      case 'firefox':
        browserEngine = firefox;
        break;
      case 'webkit':
        browserEngine = webkit;
        break;
      case 'chrome':
        browserEngine = chromium;
        channel = 'chrome';
        break;
      case 'edge':
        browserEngine = chromium;
        channel = 'msedge';
        break;
      case 'chromium':
      default:
        defaultBrowser = await cloakLaunch({
          headless,
          humanize: true,
          geoip: true,
          args: [
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-popup-blocking',
            '--mute-audio',
            '--no-first-run',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--disable-blink-features=AutomationControlled',
          ],
        });
        break;
    }
    if (browserEngine) {
      defaultBrowser = await browserEngine.launch({
        headless,
        channel,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
      });
    }
    const cleanupAllContexts = async () => {
      for (const [_email, accCtx] of accountContexts.entries()) {
        if (accCtx.refreshInterval) clearInterval(accCtx.refreshInterval);
        await accCtx.context.close();
      }
      accountContexts.clear();
      if (defaultBrowser) {
        await defaultBrowser.close();
        defaultBrowser = null;
      }
    };
    process.on('SIGTERM', cleanupAllContexts);
    process.on('SIGINT', cleanupAllContexts);
  })().finally(() => {
    initInFlight = null;
  });
  return initInFlight;
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
  await initPlaywright();
  if (!defaultBrowser) throw new Error('Playwright browser not initialized');
  if (accountContexts.has(email)) return accountContexts.get(email)!;

  // CDP mode: use the existing Chrome's default context. Cookies are already
  // set from the real browser session — no injection needed. baxia is already
  // active, wrapping fetch with real bx headers.
  if (process.env.CHROME_CDP_ENDPOINT) {
    const contexts = defaultBrowser.contexts();
    if (contexts.length === 0) throw new Error('CDP browser has no contexts');
    const context = contexts[0];
    let page = context.pages().find((p: Page) => p.url().startsWith('https://chat.qwen.ai/'));
    if (!page) {
      page = await context.newPage();
      await page.goto('https://chat.qwen.ai/', { waitUntil: 'load', timeout: 30000 });
    }
    // Verify baxia is loaded
    const hasBaxia = await page
      .evaluate(() => {
        const w = window as any;
        return !!(w.__baxia__ || w.baxiaCommon);
      })
      .catch(() => false);
    if (!hasBaxia) {
      logStore.log('warn', 'playwright', 'CDP browser: baxia not detected, reloading...');
      await page.goto('https://chat.qwen.ai/', { waitUntil: 'load', timeout: 30000 });
    }
    const accCtx: AccountContext = {
      context,
      page,
      lastRefresh: Date.now(),
      cookies: cookies || {},
      headers: {},
    };
    accountContexts.set(email, accCtx);
    return accCtx;
  }

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
    COOKIE_REFRESH_INTERVAL + Math.random() * 30000,
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

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  for (const [_email, accCtx] of accountContexts.entries()) {
    if (accCtx.refreshInterval) clearInterval(accCtx.refreshInterval);
    await accCtx.context.close();
  }
  accountContexts.clear();
  if (defaultBrowser) {
    await defaultBrowser.close();
    defaultBrowser = null;
  }
  cachedUserAgent = null;
  cachedCookies = null;
  lastCookiesTime = 0;
}
export function getCachedUserAgent(): string | null {
  return cachedUserAgent;
}
export function getCachedCookies(): string | null {
  return cachedCookies;
}
export function getLastCookiesTime(): number {
  return lastCookiesTime;
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

/**
 * Force-refresh bx headers for an account by clearing cached bx headers and
 * re-navigating the browser page to re-trigger route-based header extraction.
 * This is called reactively when a CAPTCHA challenge (FAIL_SYS_USER_VALIDATE)
 * is detected from the Qwen API.
 */
export async function forceRefreshBxHeaders(email: string): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  const accCtx = accountContexts.get(email);
  if (!accCtx) return;
  // Clear existing bx headers so they get re-extracted on next page load
  delete accCtx.headers['bx-umidtoken'];
  delete accCtx.headers['bx-ua'];
  delete accCtx.headers['user-agent'];
  try {
    await accCtx.page.goto('https://chat.qwen.ai/', { waitUntil: 'load', timeout: 30000 });
    await accCtx.page.waitForTimeout(2000);
  } catch {
    // Navigation failure is non-fatal — caller handles this gracefully
  }
  logStore.log('info', 'playwright', `bx headers refreshed for ${email.split('@')[0]}`);
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

let browserFetchFnCounter = 0;

/**
 * Base64-encode a string that may contain non-Latin1 (Unicode) characters.
 * Uses TextEncoder to produce UTF-8 bytes, then converts to Latin-1 string
 * for btoa. Safe for any Unicode input, unlike bare btoa() which throws
 * on non-Latin1 characters.
 *
 * Decode with: new TextDecoder().decode(Uint8Array.from(atob(str), c => c.charCodeAt(0)))
 */
function b64encode(str: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(str)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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
 * Result of a non-streaming fetch routed through the browser page.
 */
export interface BrowserFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
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
): Promise<BrowserFetchResult> {
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
  // This bypasses WAF by using Chrome's native TLS/HTTP2 fingerprint with
  // baxia-wrapped fetch — the only reliable way to avoid FAIL_SYS_USER_VALIDATE.
  if (process.env.CHROME_CDP_ENDPOINT) {
    const { browserFetchForAccount } = await import('./cdpClient.ts');
    return browserFetchForAccount(email, url, { method: options.method, body: options.body, timeout: options.timeout || 30000 });
  }

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

/**
 * Make a streaming HTTP request through the account's browser page and return
 * a Node.js ReadableStream that receives SSE chunks in real-time.
 *
 * Architecture:
 *   Browser `fetch()` inside page.evaluate()
 *     -> reads Response.body.getReader() chunk by chunk
 *     -> each chunk base64-encoded and sent via page.exposeFunction()
 *     -> Node.js callback decodes and enqueues into a ReadableStream
 *
 * The browser handles all TLS, headers, cookies, and baxia instrumentation.
 * The Node.js process just receives raw SSE bytes as they arrive.
 *
 * Each stream creates a unique exposed function (`__qsb_N_timestamp`) on the
 * page. These accumulate on the page but are bounded by the number of
 * concurrent streams × accounts (< 50 for any realistic workload).
 * Page navigations (from refreshAccountCookies) clear them naturally.
 *
 * Suitable for: chat completions (SSE streaming).
 */
export async function performBrowserStream(
  email: string,
  url: string,
  body: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    // In test mode, delegate to globalThis.fetch (which the test has mocked).
    // The mock returns a ReadableStream that the test controls.
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!resp.ok) {
      throw new Error(`[TEST_MOCK] Browser stream fetch returned ${resp.status}`);
    }
    return resp.body!;
  }

  // CDP mode: route through real Chrome's network stack with incremental streaming.
  // Uses Runtime.addBinding + XHR onprogress to deliver SSE chunks in real time.
  if (process.env.CHROME_CDP_ENDPOINT) {
    const { browserStreamFetchIncrementalForAccount } = await import('./cdpClient.ts');
    const result = await browserStreamFetchIncrementalForAccount(email, url, body);
    if (!result.ok) {
      const errPayload = JSON.stringify({ __httpError: true, status: result.status, body: '' });
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(errPayload));
          controller.close();
        },
      });
    }
    return result.stream;
  }

  const accCtx = accountContexts.get(email);
  if (!accCtx) throw new Error(`No browser context for account ${email}`);
  const { page } = accCtx;
  await ensurePageAtSpaRoot(page);
  // Unique function name per stream — prevents collisions across concurrent streams
  const fnName = `__qsb_${++browserFetchFnCounter}_${Date.now()}`;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let streamClosed = false;
  const nodeStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      streamClosed = true;
    },
  });
  // Helper: clean up abort listener when stream ends for any reason
  const cleanupAbort = () => {
    if (signal) signal.removeEventListener('abort', onAbort);
  };
  // Bridge function: browser calls window[fnName](b64chunk)
  // Node.js decodes base64 and enqueues the raw bytes into the ReadableStream.
  try {
    await page.exposeFunction(fnName, (b64: string) => {
      if (streamClosed) return;
      if (b64 === '__QSB_DONE__') {
        streamClosed = true;
        cleanupAbort();
        try {
          streamController?.close();
        } catch {
          /* already closed by cancel */
        }
        return;
      }
      if (b64 === '__QSB_ERROR__') {
        streamClosed = true;
        cleanupAbort();
        try {
          streamController?.error(new Error('Browser stream fetch failed'));
        } catch {
          /* already closed */
        }
        return;
      }
      try {
        const binary = atob(b64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        if (!streamClosed) streamController?.enqueue(bytes);
      } catch {
        // Corrupted chunk or controller already closed — skip silently
      }
    });
  } catch (err: any) {
    streamClosed = true;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (streamController as ReadableStreamDefaultController<Uint8Array> | null)?.error(err);
    throw err;
  }
  // Wire abort signal: when Node.js aborts, stop accepting chunks so
  // the SSE pipeline terminates. Don't close the controller here —
  // let __QSB_DONE__ or natural XHR completion handle the close.
  // The consumer's cancel() handler will clean up the stream.
  const onAbort = () => {
    if (!streamClosed) {
      streamClosed = true;
      cleanupAbort();
    }
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      return nodeStream;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  // Launch the browser fetch in the background (fire-and-forget).
  // The fetch uses the real Chrome TLS stack, automatic sec-ch-ua headers,
  // all cookies (credentials: 'include'), and active baxia instrumentation.
  page
    .evaluate(
      async (opts: { url: string; body: string; fnName: string }) => {
        // Use XMLHttpRequest (not fetch) because baxia wraps XHR to inject
        // bx-umidtoken and bx-ua headers. Without these the WAF challenges
        // certain API endpoints.
        const xhr = new XMLHttpRequest();
        xhr.open('POST', opts.url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('Accept', 'text/event-stream');
        xhr.responseType = 'text';

        const bridge = (window as any)[opts.fnName];

        // Stream SSE chunks via the bridge as they arrive
        let lastIndex = 0;
        xhr.onprogress = () => {
          const chunk = xhr.responseText.slice(lastIndex);
          if (chunk) {
            const uint8 = new TextEncoder().encode(chunk);
            let binary = '';
            for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
            bridge(btoa(binary));
            lastIndex = xhr.responseText.length;
          }
        };

        // On completion: send error payload for non-2xx, then signal DONE
        xhr.onloadend = () => {
          if (xhr.status > 0 && (xhr.status < 200 || xhr.status >= 300)) {
            const errPayload = JSON.stringify({ __httpError: true, status: xhr.status, body: xhr.responseText || '' });
            bridge(btoa(errPayload));
          }
          bridge('__QSB_DONE__');
        };

        xhr.onerror = () => {
          bridge('__QSB_DONE__');
        };

        xhr.send(opts.body);

        // Keep the page.evaluate alive until the XHR completes
        await new Promise<void>((resolve) => {
          const check = () => {
            if (xhr.readyState === 4) resolve();
            else setTimeout(check, 100);
          };
          check();
        });
      },
      { url, body, fnName },
    )
    .catch((err: any) => {
      // page.evaluate threw — browser fetch failed entirely
      if (!streamClosed) {
        streamClosed = true;
        cleanupAbort();
        streamController?.error(err);
      }
    });
  return nodeStream;
}
