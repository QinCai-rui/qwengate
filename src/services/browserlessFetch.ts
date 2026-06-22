/**
 * browserlessFetch — wreq-js wrapper for browserless TLS/HTTP2 impersonation.
 *
 * Replaces native fetch() for Qwen API calls with Chrome 142 TLS fingerprinting.
 * Manages:
 *   - TLS/HTTP2 impersonation (wreq-js with Chrome 142 profile)
 *   - Session-scoped cookie persistence per account
 *   - bx-umidtoken auto-extraction + caching
 *   - bx-v / bx-et static headers
 *
 * Phase A: bx-ua still uses fallback (Phase B adds fireyejs generation).
 * Phase C: bx-pp will be added per-request.
 */
import wreq, { type BrowserProfile, type EmulationOS, type Session } from 'wreq-js';
import { extractBxUmidtoken } from './bxTokenExtractor.ts';
import { generateBxPp, generateBxUa, refreshCookiesViaBrowser } from './fireyejsRunner.ts';
import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';
import { tokenCache } from './tokenCache.ts';

// ponytail: single shared session for now. Upgrade to per-account sessions when
// multiple accounts need independent cookie jars.
let defaultSession: Session | null = null;

const ACCOUNT_SESSIONS = new Map<string, Session>();
// Single-flight guard: one cookie refresh per account at a time
const cookieRefreshInFlight = new Map<string, Promise<string | null>>();
const BX_UMIDTOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (confirmed hours-days from research)
const BX_UA_TTL_MS = 15 * 60 * 1000; // 15 minutes — fireyejs token refresh interval

export interface BrowserlessFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Per-account session isolation for cookie continuity. */
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
//
// acw_tc is a session cookie set by Alibaba's WAF (Web Application Firewall)
// on first visit to chat.qwen.ai. It must be present in requests or baxia
// treats the session as unverified. The cookie has a ~30min TTL and must be
// refreshed periodically.
//
// We maintain a background refresh timer that re-fetches from the Qwen root
// page to keep acw_tc alive.

let acwTcRefreshTimer: ReturnType<typeof setInterval> | null = null;
const ACW_TC_REFRESH_MS = 15 * 60 * 1000; // 15 minutes

/** Fetch acw_tc cookie from the Qwen root page. */
async function refreshAcwTcCookie(): Promise<string | null> {
  try {
    const session = await getSession();
    // A GET to chat.qwen.ai sets the acw_tc cookie via Set-Cookie
    const resp = await session.fetch(QWEN_API_BASE, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const cookies =
      resp.headers instanceof wreq.Headers
        ? (resp.headers as unknown as { get?: (k: string) => string | null } & Iterable<[string, string]>)
        : null;
    let acwTc: string | null = null;
    // Check set-cookie header from response
    const setCookie = typeof (resp as any).headers?.get === 'function' ? (resp as any).headers.get('set-cookie') : null;
    if (setCookie && setCookie.includes('acw_tc=')) {
      const match = setCookie.match(/acw_tc=([^;]+)/);
      if (match) acwTc = match[1];
    }
    // Also get from session cookies (wreq stores them)
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
  // Initial fetch after a short delay (don't slow first request)
  setTimeout(() => {
    refreshAcwTcCookie().catch(() => {});
  }, 1000);
  acwTcRefreshTimer = setInterval(() => {
    refreshAcwTcCookie().catch(() => {});
  }, ACW_TC_REFRESH_MS);
}

/** Inject acw_tc cookie into headers from cache. */
async function ensureAcwTcCookie(headers: Record<string, string>): Promise<void> {
  // Start the background refresh loop on first call
  startAcwTcRefresh();

  let acwTc = tokenCache.get('acw_tc') ?? null;
  if (!acwTc) {
    acwTc = await refreshAcwTcCookie();
  }
  if (acwTc) {
    // Append acw_tc to existing cookie header
    const existing = headers['cookie'] || '';
    if (!existing.includes('acw_tc=')) {
      headers['cookie'] = existing ? `${existing}; acw_tc=${acwTc}` : `acw_tc=${acwTc}`;
    }
  }
}

/**
 * Make a browserless HTTP request to Qwen API.
 *
 * Returns a standard Response-compatible object (wreq-js returns native fetch-style Response).
 * Use `response.body.getReader()` for SSE streaming — works identically to native fetch.
 *
 * @example
 * ```ts
 * const resp = await browserlessFetch('https://chat.qwen.ai/api/v2/chat/completions', {
 *   method: 'POST',
 *   headers: { 'content-type': 'application/json', cookie: '...' },
 *   body: JSON.stringify(payload),
 *   accountEmail: 'user@example.com',
 * });
 * ```
 */
export async function browserlessFetch(url: string, options: BrowserlessFetchOptions = {}): Promise<Response> {
  // ponytail: test mode uses globalThis.fetch so tests can mock it. Same pattern as playwright.ts.
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const { method = 'GET', headers = {}, body } = options;
    return globalThis.fetch(url, { method, headers, body });
  }

  // ponytail: wreq-js Response is compatible for our use (status, body, headers, json, text)
  // but missing `bytes()` from the global Response type. This cast is safe for our usage.
  const { method = 'GET', headers = {}, body, accountEmail, signal, browser: browserProfile = 'chrome_142', os = 'linux' } = options;

  const session = await getSession(accountEmail, browserProfile, os);

  // Auto-inject bx tokens
  await ensureBxUmidtoken(headers);

  // Static bx headers
  if (!headers['bx-v']) headers['bx-v'] = '2.5.36';
  if (!headers['bx-et']) headers['bx-et'] = 'nosgn';

  // bx-ua: try cache first, then fireyejs, then static fallback
  if (!headers['bx-ua']) {
    const cached = tokenCache.get('bx-ua');
    if (cached) {
      headers['bx-ua'] = cached;
    } else {
      try {
        const generated = await generateBxUa();
        if (generated) headers['bx-ua'] = generated;
      } catch {
        // fireyejs not available yet — use fallback
      }
    }
    if (!headers['bx-ua']) {
      headers['bx-ua'] = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    }
  }

  // bx-pp: per-request sign (Phase C)
  if (!headers['bx-pp']) {
    try {
      const pp = await generateBxPp(body);
      if (pp) headers['bx-pp'] = pp;
    } catch {
      // bx-pp optional — skip if not available
    }
  }

  const startTime = Date.now();
  try {
    let response = await session.fetch(url, {
      method,
      headers,
      body,
      disableDefaultHeaders: true, // ponytail: prevent wreq-js overriding our API-style headers (sec-fetch-*, Accept) with navigation defaults
      // ponytail: signal not directly supported by wreq-js session.fetch — upgrade if abort needed
    });

    const wafCheck = (r: any): boolean => {
      // Detect WAF challenge: 302/403, or 200 with HTML body containing WAF keywords
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

    // Auto-refresh cookies and retry once on WAF detection
    if (wafCheck(response)) {
      logStore.log('warn', 'browserless', `WAF detected on ${url.split('?')[0]} — trying HTTP refresh first...`);
      const currentCookie = headers['cookie'] || '';

      // Try cheap wreq-js GET first (same TLS profile, may get fresh acw_tc)
      const freshAcwTc = await refreshAcwTcCookie();
      if (freshAcwTc && !currentCookie.includes('acw_tc=')) {
        headers['cookie'] = currentCookie ? `${currentCookie}; acw_tc=${freshAcwTc}` : `acw_tc=${freshAcwTc}`;
      }

      // Still WAF? Fall back to Playwright browser navigation
      const responseText = await response.text().catch(() => '');
      const isStillWaf = !responseText || responseText.includes('aliyun_waf') || responseText.includes('<html');
      if (!isStillWaf) {
        // HTTP refresh worked — return the original response
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
        // Clear stale tokens so they get regenerated
        tokenCache.delete('bx-ua');
        tokenCache.delete('bx-pp');
        tokenCache.delete('acw_tc');
        // Re-inject fresh bx tokens
        await ensureBxUmidtoken(headers);
        headers['bx-ua'] = (await generateBxUa()) || headers['bx-ua'];
        const pp = await generateBxPp(body);
        if (pp) headers['bx-pp'] = pp;
        logStore.log('info', 'browserless', `Retrying ${url.split('?')[0]} with fresh cookies...`);
        // Close old session, get a fresh one for new TLS connection
        ACCOUNT_SESSIONS.delete(accountEmail || '_default_');
        try {
          await (session as any).close?.();
        } catch {}
        const freshSession = await getSession(accountEmail, browserProfile, os);
        response = await freshSession.fetch(url, { method, headers, body, disableDefaultHeaders: true });
        // Re-check after retry
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

    // If bx-umidtoken got stale, evict and let caller retry
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
      // already closed
    }
  }
}
