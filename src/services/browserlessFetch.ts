/**
 * browserlessFetch — wreq-js wrapper for browserless TLS/HTTP2 impersonation.
 *
 * Uses wreq-js (Rust native addon with Chrome 142 fingerprint) to bypass
 * Alibaba WAF. NLcURL was evaluated but its TLS fingerprint doesn't pass
 * the WAF — only wreq-js Chrome 142 profiles do.
 *
 * Manages:
 *   - TLS/HTTP2 impersonation (wreq-js with Chrome 142 profile)
 *   - bx-umidtoken auto-extraction + caching
 *   - bx-v / bx-et static headers
 *   - WAF detection + recovery via Playwright cookie refresh
 */
import wreq, { type BrowserProfile, type EmulationOS, type Session } from 'wreq-js';
import { extractBxUmidtoken } from './bxTokenExtractor.ts';
import { generateBxPp, generateBxUa, refreshCookiesViaBrowser } from './fireyejsRunner.ts';
import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';
import { tokenCache } from './tokenCache.ts';

// ponytail: per-request sessions to avoid wreq-js tokio epoll crash on reuse.
// Each browserlessFetch call creates a fresh session. This costs ~200ms per
// request but avoids the "Bad file descriptor" panic when reusing sessions in Bun.
let defaultSession: Session | null = null;
const ACCOUNT_SESSIONS = new Map<string, Session>();
// Single-flight guard: one cookie refresh per account at a time
const cookieRefreshInFlight = new Map<string, Promise<string | null>>();
const BX_UMIDTOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const BX_UA_TTL_MS = 15 * 60 * 1000;

export interface BrowserlessFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  accountEmail?: string;
  signal?: AbortSignal;
  /** Chrome browser profile version (default: 'chrome_142') */
  browser?: BrowserProfile;
  /** OS for client hints (default: 'linux') */
  os?: EmulationOS;
}

/** Get or create a wreq-js session for the given account. */
function getSession(accountEmail?: string, browser: BrowserProfile = 'chrome_142', os: EmulationOS = 'linux'): Promise<Session> {
  const key = accountEmail || '_default_';
  const existing = ACCOUNT_SESSIONS.get(key);
  if (existing && !(existing as any).disposed) {
    return Promise.resolve(existing);
  }
  return wreq.createSession({ browser, os }).then((session) => {
    ACCOUNT_SESSIONS.set(key, session);
    return session;
  });
}

/** Ensure bx-umidtoken is in headers, fetching from cache or sg-wum endpoint. */
async function ensureBxUmidtoken(headers: Record<string, string>): Promise<void> {
  if (headers['bx-umidtoken']) return;
  const token = await tokenCache.getOrSet('bx-umidtoken', extractBxUmidtoken, BX_UMIDTOKEN_TTL_MS);
  headers['bx-umidtoken'] = token;
}

// ─── acw_tc cookie (Alibaba WAF) ────────────────────────────────────────────

let acwTcRefreshTimer: ReturnType<typeof setInterval> | null = null;
const ACW_TC_REFRESH_MS = 15 * 60 * 1000; // 15 minutes

/** Fetch acw_tc cookie from the Qwen root page. */
async function refreshAcwTcCookie(): Promise<string | null> {
  try {
    const session = await getSession();
    const resp = await session.fetch(QWEN_API_BASE, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    let acwTc: string | null = null;
    const setCookie = typeof (resp as any).headers?.get === 'function' ? (resp as any).headers.get('set-cookie') : null;
    if (setCookie && setCookie.includes('acw_tc=')) {
      const match = setCookie.match(/acw_tc=([^;]+)/);
      if (match) acwTc = match[1];
    }
    if (!acwTc) {
      const sessionCookies = session.getCookies?.(QWEN_API_BASE) || {};
      acwTc = (sessionCookies as Record<string, string>)['acw_tc'] || null;
    }
    if (acwTc) {
      tokenCache.set('acw_tc', acwTc, ACW_TC_REFRESH_MS * 2);
      logStore.log('debug', 'browserless', `acw_tc cookie refreshed: ${acwTc.substring(0, 16)}...`);
    }
    return acwTc;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'browserless', `acw_tc refresh failed: ${msg}`);
    return null;
  }
}

/** Start periodic acw_tc refresh (idempotent). */
function startAcwTcRefresh(): void {
  if (acwTcRefreshTimer) return;
  setTimeout(() => {
    refreshAcwTcCookie().catch(() => {});
  }, 1000);
  acwTcRefreshTimer = setInterval(() => {
    refreshAcwTcCookie().catch(() => {});
  }, ACW_TC_REFRESH_MS);
}

/** Inject acw_tc cookie into headers from cache. */
async function ensureAcwTcCookie(headers: Record<string, string>): Promise<void> {
  startAcwTcRefresh();

  let acwTc = tokenCache.get('acw_tc') ?? null;
  if (!acwTc) {
    acwTc = await refreshAcwTcCookie();
  }
  if (acwTc) {
    const existing = headers['cookie'] || '';
    if (!existing.includes('acw_tc=')) {
      headers['cookie'] = existing ? `${existing}; acw_tc=${acwTc}` : `acw_tc=${acwTc}`;
    }
  }
}

/**
 * Make a browserless HTTP request to Qwen API.
 *
 * Returns a standard Response-compatible object.
 * Use `response.body.getReader()` for SSE streaming.
 */
export async function browserlessFetch(url: string, options: BrowserlessFetchOptions = {}): Promise<Response> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const { method = 'GET', headers = {}, body } = options;
    return globalThis.fetch(url, { method, headers, body });
  }

  const { method = 'GET', headers = {}, body, accountEmail, signal, browser: browserProfile = 'chrome_142', os = 'linux' } = options;

  const session = await getSession(accountEmail, browserProfile, os);

  // Auto-inject bx tokens
  await ensureBxUmidtoken(headers);

  if (!headers['bx-v']) headers['bx-v'] = '2.5.36';
  if (!headers['bx-et']) headers['bx-et'] = 'nosgn';

  if (!headers['bx-ua']) {
    const cached = tokenCache.get('bx-ua');
    if (cached) {
      headers['bx-ua'] = cached;
    } else {
      try {
        const generated = await generateBxUa();
        if (generated) headers['bx-ua'] = generated;
      } catch {
        /* fallback */
      }
    }
    if (!headers['bx-ua']) {
      headers['bx-ua'] = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    }
  }

  if (!headers['bx-pp']) {
    try {
      const pp = await generateBxPp(body);
      if (pp) headers['bx-pp'] = pp;
    } catch {
      /* optional */
    }
  }

  await ensureAcwTcCookie(headers);

  const startTime = Date.now();
  try {
    let response = await session.fetch(url, {
      method,
      headers,
      body,
      disableDefaultHeaders: true,
    });

    const wafCheck = (r: any): boolean => {
      if (r.status === 302) return true;
      if (r.status === 403) return true;
      if (r.status === 200) {
        try {
          const ct = (r.headers?.get?.('content-type') || '') as string;
          if (ct.includes('text/html')) return true;
        } catch {
          /* ignore */
        }
      }
      return false;
    };

    if (wafCheck(response)) {
      logStore.log('warn', 'browserless', `WAF detected on ${url.split('?')[0]} — trying HTTP refresh first...`);
      const currentCookie = headers['cookie'] || '';

      const freshAcwTc = await refreshAcwTcCookie();
      if (freshAcwTc && !currentCookie.includes('acw_tc=')) {
        headers['cookie'] = currentCookie ? `${currentCookie}; acw_tc=${freshAcwTc}` : `acw_tc=${freshAcwTc}`;
      }

      const responseText = await response.text().catch(() => '');
      const isStillWaf = !responseText || responseText.includes('aliyun_waf') || responseText.includes('<html');
      if (!isStillWaf) {
        return response as unknown as Response;
      }

      logStore.log('warn', 'browserless', `HTTP refresh failed — trying Playwright browser...`);
      const key = accountEmail || '_default_';
      let promise = cookieRefreshInFlight.get(key);
      if (!promise) {
        promise = refreshCookiesViaBrowser(currentCookie).finally(() => {
          cookieRefreshInFlight.delete(key);
        });
        cookieRefreshInFlight.set(key, promise);
      }
      const freshCookies = await promise;
      if (freshCookies) {
        headers['cookie'] = freshCookies;
        tokenCache.delete('bx-ua');
        tokenCache.delete('bx-pp');
        tokenCache.delete('acw_tc');
        await ensureBxUmidtoken(headers);
        headers['bx-ua'] = (await generateBxUa()) || headers['bx-ua'];
        const pp = await generateBxPp(body);
        if (pp) headers['bx-pp'] = pp;
        logStore.log('info', 'browserless', `Retrying ${url.split('?')[0]} with fresh cookies...`);

        ACCOUNT_SESSIONS.delete(accountEmail || '_default_');
        try {
          await (session as any).close?.();
        } catch {}
        const freshSession = await getSession(accountEmail, browserProfile, os);
        response = await freshSession.fetch(url, { method, headers, body, disableDefaultHeaders: true });
        if (wafCheck(response)) {
          throw new Error(`WAF challenge persists after cookie refresh for ${url.split('?')[0]}`);
        }
      }
      if (!freshCookies) {
        throw new Error(`Cookie refresh failed for ${url.split('?')[0]} — cannot retry`);
      }
    }

    const elapsed = Date.now() - startTime;
    logStore.log('debug', 'browserless', `${method} ${url.split('?')[0]} → ${response.status} (${elapsed}ms)`);

    return response as unknown as Response;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'browserless', `${method} ${url.split('?')[0]} failed after ${elapsed}ms: ${msg}`);

    if (msg.includes('403') || msg.includes('FAIL_SYS_USER_VALIDATE')) {
      tokenCache.delete('bx-umidtoken');
    }

    throw err;
  }
}

/** Dispose a session for the given account (e.g. on logout/error). */
export async function disposeSession(accountEmail?: string): Promise<void> {
  const key = accountEmail || '_default_';
  const session = ACCOUNT_SESSIONS.get(key);
  if (session) {
    ACCOUNT_SESSIONS.delete(key);
    try {
      await (session as any).close();
    } catch {
      /* already closed */
    }
  }
}
