/**
 * GLM Cookie Manager — periodic refresh of GLM WAF cookies.
 *
 * GLM/z.ai sits behind Alibaba Cloud WAF (the same infrastructure as Qwen).
 * The acw_tc, cdn_sec_tc, ssxmod_itna cookies expire and need periodic refresh.
 *
 * Strategy:
 *   1. Periodically fetch the root page via wreqFetch to get fresh acw_tc + cookies
 *   2. Store cookies per-account in the tokenCache
 *   3. Expose getGlmCookieString() for the pipeline
 */

import { tokenCache } from './tokenCache.ts';
import { wreqFetch } from './wreqFetch.ts';
import { logStore } from './logStore.ts';
import { getProviderState } from './accountManager.ts';

const GLM_BASE_URL = 'https://chat.z.ai';
const COOKIE_REFRESH_MS = 15 * 60 * 1000; // 15 minutes (matches Qwen's interval)
const COOKIE_CACHE_TTL = COOKIE_REFRESH_MS * 2;

// Single-flight guard per account
const refreshInFlight = new Map<string, Promise<void>>();

/**
 * Refresh cookies for a GLM account by fetching the root page.
 * Extracts all Set-Cookie headers from the response.
 */
export async function refreshGlmCookies(email: string, jwt: string): Promise<string | null> {
  const key = email || '_default_';

  // Single-flight: don't refresh concurrently for the same account
  const existing = refreshInFlight.get(key);
  if (existing) {
    await existing;
    return getGlmCookieString(email, jwt);
  }

  const refreshPromise: Promise<void> = (async () => {
    try {
      logStore.log('debug', 'glm-cookies', `Refreshing cookies for ${email || 'default'}...`);

      const resp = await wreqFetch(GLM_BASE_URL, {
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        },
        timeout: 15,
        impersonate: 'chrome_142',
      });

      // Parse all Set-Cookie headers
      const cookies: string[] = [];

      // wreqFetch wraps Set-Cookie in X-Upstream-Headers
      const upstreamHeaders = resp.headers.get('X-Upstream-Headers');
      if (upstreamHeaders) {
        try {
          const parsed = JSON.parse(Buffer.from(upstreamHeaders, 'base64').toString());
          if (parsed['set-cookie']) {
            const setCookieHeaders = Array.isArray(parsed['set-cookie']) ? parsed['set-cookie'] : [parsed['set-cookie']];

            for (const cookieStr of setCookieHeaders) {
              // Extract just the name=value part (before first ;)
              const nameValue = cookieStr.split(';')[0];
              if (nameValue) cookies.push(nameValue);
            }
          }
        } catch {
          /* ignore parse errors */
        }
      }

      if (cookies.length > 0) {
        const cookieString = cookies.join('; ');
        tokenCache.set(`glm_cookies_${email}`, cookieString, COOKIE_CACHE_TTL);

        // Also store in provider state for the session
        const state = getProviderState(email, 'glm');
        if (state) {
          state.cookies = cookieString;
        }

        logStore.log('debug', 'glm-cookies', `Refreshed ${cookies.length} cookies for ${email || 'default'}`);
      } else {
        logStore.log('warn', 'glm-cookies', `No cookies returned for ${email || 'default'}`);
        // Keep existing cookies if we already have them — no-op, the cookie jar persists
      }
    } catch (err: any) {
      logStore.log('warn', 'glm-cookies', `Cookie refresh failed for ${email}: ${err.message}`);
    }
  })();

  refreshInFlight.set(key, refreshPromise);
  try {
    await refreshPromise;
  } finally {
    refreshInFlight.delete(key);
  }

  return getGlmCookieString(email, jwt);
}

/**
 * Get the current cookie string for a GLM account.
 * Returns the stored cookie jar or the JWT as fallback.
 */
export function getGlmCookieString(email: string, jwt: string): string {
  // Try token cache first
  const cached = tokenCache.get(`glm_cookies_${email}`);
  if (cached) return cached;

  // Try provider state
  const state = getProviderState(email, 'glm');
  if (state?.cookies) {
    tokenCache.set(`glm_cookies_${email}`, state.cookies, COOKIE_CACHE_TTL);
    return state.cookies;
  }

  // Fallback: just use the JWT token cookie
  return `token=${jwt}`;
}

/**
 * Replace or add a specific cookie in the cookie string for an account.
 */
export function setGlmCookieValue(email: string, jwt: string, key: string, value: string): void {
  const current = getGlmCookieString(email, jwt);
  const regex = new RegExp(`${key}=[^;]+;?\\s*`, 'g');
  let updated: string;

  if (current.includes(`${key}=`)) {
    updated = current.replace(regex, `${key}=${value}; `);
  } else {
    updated = current ? `${current}; ${key}=${value}` : `${key}=${value}`;
  }

  tokenCache.set(`glm_cookies_${email}`, updated, COOKIE_CACHE_TTL);

  const state = getProviderState(email, 'glm');
  if (state) {
    state.cookies = updated;
  }
}

/**
 * Start periodic cookie refresh for an account (idempotent).
 */
const refreshTimers = new Map<string, ReturnType<typeof setInterval>>();

export function startGlmCookieRefresh(email: string, jwt: string): void {
  if (refreshTimers.has(email)) return;

  // Initial refresh after 1 second
  setTimeout(() => {
    refreshGlmCookies(email, jwt).catch(() => {});
  }, 1000);

  // Periodic refresh
  const timer = setInterval(() => {
    refreshGlmCookies(email, jwt).catch(() => {});
  }, COOKIE_REFRESH_MS);

  refreshTimers.set(email, timer);
  logStore.log('debug', 'glm-cookies', `Started periodic cookie refresh for ${email} (every ${COOKIE_REFRESH_MS / 1000}s)`);
}

export function stopGlmCookieRefresh(email: string): void {
  const timer = refreshTimers.get(email);
  if (timer) {
    clearInterval(timer);
    refreshTimers.delete(email);
  }
}
