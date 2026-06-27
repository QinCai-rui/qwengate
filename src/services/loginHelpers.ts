/*
 * File: loginHelpers.ts
 * Login implementation helpers extracted from auth.ts.
 * Contains the three login strategies: browser context, fetch, and temp context.
 * Also provides shared manual browser login for provider accounts.
 */

import crypto from 'crypto';
import { chromium, Page } from 'playwright';
import type { AuthState, ProviderAuthState } from '../types/auth.ts';
import { checkPlaywrightSession, getAuthTokenMaxAgeMs } from './auth.ts';
import { logStore } from './logStore.ts';
import { AccountContext, createAccountContext, getActivePage, getBrowser, Mutex, removeAccountContext } from './playwright.ts';
import { createFetchTimeout, QWEN_BX_V } from './qwen.ts';

const QWEN_CHAT_URL = 'https://chat.qwen.ai';

/**
 * Login via browser context — executes signin API inside the browser via evaluate().
 */
export async function loginFreshViaBrowser(email: string, hashedPassword: string, loginMutex: Mutex): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const page = getActivePage();
    if (!page) return null;

    try {
      const currentUrl = page.url();
      if (!currentUrl.startsWith(QWEN_CHAT_URL)) {
        await page.goto(QWEN_CHAT_URL, { waitUntil: 'domcontentloaded' });
      }
    } catch (err: any) {
      logStore.log('warn', 'auth', `Navigation check failed for ${email}: ${err.message}`);
    }

    try {
      const context = page.context();
      const existingCookies = await context.cookies();
      const authCookies = existingCookies.filter((c) => c.name === 'token' || c.name === 'refresh_token');
      if (authCookies.length > 0) {
        // Only remove specific auth cookies, not ALL cookies
        for (const c of authCookies) {
          await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
        }
      }
    } catch (err: any) {
      logStore.log('warn', 'auth', `Cookie clearing failed for ${email}: ${err.message}`);
    }

    let evalResult: { ok: boolean; status: number; token: string | null; refreshToken: string | null; dataKeys: string[] };
    try {
      evalResult = await page.evaluate(
        async ({ email, hashedPassword }: { email: string; hashedPassword: string }) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15_000);
          let response: Response;
          try {
            response = await fetch(`${QWEN_CHAT_URL}/api/v2/auths/signin`, {
              method: 'POST',
              headers: {
                accept: 'application/json, text/plain, */*',
                'content-type': 'application/json',
                source: 'web',
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                'x-request-id': crypto.randomUUID(),
              },
              credentials: 'include',
              body: JSON.stringify({ email, password: hashedPassword }),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          let data: any = {};
          try {
            data = await response.json();
          } catch {
            // non-blocking: non-JSON responses fall back to empty data
          }

          const token = data?.data?.token || data?.token || data?.data?.session_token || null;
          const refreshToken = data?.data?.refresh_token || data?.refresh_token || null;

          return {
            ok: response.ok,
            status: response.status,
            token: token as string | null,
            refreshToken: refreshToken as string | null,
            dataKeys: Object.keys(data),
          };
        },
        { email, hashedPassword },
      );
    } catch (err: any) {
      logStore.log('error', 'auth', `Browser evaluate failed for ${email}: ${err.message}`);
      return null;
    }

    if (!evalResult.ok) {
      logStore.log('error', 'auth', `Login failed for ${email} (${evalResult.status})`);
      return null;
    }

    let cookieToken: string | null = null;
    let cookieRefresh: string | null = null;
    try {
      const cookies = await page.context().cookies();
      const tokenCookie = cookies.find(
        (c) =>
          c.name === 'token' ||
          (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh')),
      );
      const refreshCookie = cookies.find(
        (c) => c.name === 'refresh_token' || (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen')),
      );
      cookieToken = tokenCookie?.value || null;
      cookieRefresh = refreshCookie?.value || null;
    } catch (err: any) {
      logStore.log('warn', 'auth', `Cookie read failed for ${email}: ${err.message}`);
    }

    const finalToken = evalResult.token || cookieToken;
    const finalRefresh = evalResult.refreshToken || cookieRefresh;

    if (finalToken) {
      return {
        token: finalToken,
        expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
        refreshToken: finalRefresh,
      };
    }

    logStore.log(
      'warn',
      'auth',
      `Login returned 200 for ${email} but no token found. ` +
        `Response keys: [${evalResult.dataKeys.join(', ')}]. ` +
        `No auth cookies captured.`,
    );
    return null;
  } finally {
    release();
  }
}

/**
 * Login via plain fetch — fallback for when Playwright is not available.
 */
export async function loginFreshViaFetch(email: string, hashedPassword: string): Promise<AuthState | null> {
  const { controller, cleanup: _cleanup } = createFetchTimeout();
  try {
    const response = await fetch(`${QWEN_CHAT_URL}/api/v2/auths/signin`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        source: 'web',
        Version: '0.2.57',
        'bx-v': QWEN_BX_V,
        Referer: `${QWEN_CHAT_URL}/auth`,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ email, password: hashedPassword }),
      signal: controller.signal,
    });

    if (response.ok) {
      let data: any;
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      let token = data.data?.token || data.token || data.data?.session_token || null;
      let refreshToken = data.data?.refresh_token || data.refresh_token || null;

      if (!token) {
        const hdrs = response.headers as Headers & { getSetCookie?: () => string[] };
        const setCookies: string[] =
          typeof hdrs.getSetCookie === 'function' ? hdrs.getSetCookie() : (response.headers.get('set-cookie') || '').split(',');

        for (const cookie of setCookies) {
          const tokenMatch = cookie.match(/\btoken=([^;]+)/);
          if (tokenMatch && !token) token = tokenMatch[1];
          const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
          if (refreshMatch) refreshToken = refreshMatch[1];
        }
      }

      if (token) {
        return {
          token,
          expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
          refreshToken,
        };
      }

      const hasPlaywrightSession = await checkPlaywrightSession();
      if (hasPlaywrightSession) {
        logStore.log(
          'warn',
          'auth',
          `API login returned 200 but no token for ${email}, and Playwright session exists but has no usable token`,
        );
      }

      logStore.log('warn', 'auth', `API login returned 200 but no token for ${email}: ${JSON.stringify(data).substring(0, 200)}`);
    } else {
      const errText = await response.text();
      logStore.log('error', 'auth', `Login failed for ${email} (${response.status}): ${errText.substring(0, 200)}`);
    }
  } catch (err: any) {
    logStore.log('error', 'auth', `Login error for ${email}: ${err.message}`);
  }

  return null;
}

export async function loginViaTempContext(
  _browser: ReturnType<typeof getBrowser>,
  email: string,
  hashedPassword: string,
  loginMutex: Mutex,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  let accCtx: AccountContext | null = null;
  try {
    accCtx = await createAccountContext(email);
    const page = accCtx.page;
    const context = accCtx.context;

    let capturedToken: string | null = null;
    let capturedRefresh: string | null = null;

    // Intercept signin API to capture token from BOTH JSON body AND set-cookie headers
    await page.route('**/api/v2/auths/signin', async (route) => {
      try {
        const response = await route.fetch();

        // Try to extract token from JSON response body first (fastest path)
        try {
          const body = await response.json();
          const jsonToken = body?.data?.token || body?.token || body?.data?.session_token || null;
          const jsonRefresh = body?.data?.refresh_token || body?.refresh_token || null;
          if (jsonToken && !capturedToken) capturedToken = jsonToken;
          if (jsonRefresh && !capturedRefresh) capturedRefresh = jsonRefresh;
        } catch {
          logStore.log('warn', 'auth', 'signin route fetch returned non-JSON response');
        }

        // Also check set-cookie headers as fallback
        const setCookies = response
          .headersArray()
          .filter((h) => h.name.toLowerCase() === 'set-cookie')
          .map((h) => h.value);
        for (const cookie of setCookies) {
          const tokenMatch = cookie.match(/\btoken=([^;]+)/);
          if (tokenMatch && !capturedToken) capturedToken = tokenMatch[1];
          const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
          if (refreshMatch && !capturedRefresh) capturedRefresh = refreshMatch[1];
        }

        await route.fulfill({ response });
      } catch {
        // If route.fetch fails, let the request pass through normally
        await route.continue();
      }
    });

    try {
      await page.goto(`${QWEN_CHAT_URL}/auth`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch {
      logStore.log('warn', 'auth', `goto auth page failed for ${email}`);
    }

    try {
      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10_000 });
      await page.fill('input[type="email"], input[name="email"]', email);
      await page.fill('input[type="password"], input[name="password"]', hashedPassword);
      await Promise.all([
        page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")'),
        page.waitForURL((url) => !url.toString().includes('/auth'), { timeout: 15_000 }).catch(() => {}),
      ]);
    } catch {
      logStore.log('warn', 'auth', `form fill/submit failed for ${email}`);
    }

    // Poll for token with shorter intervals instead of blind sleep
    for (let attempt = 0; attempt < 10; attempt++) {
      if (capturedToken) break;
      await new Promise((r) => setTimeout(r, 500));

      // Check cookies as fallback
      try {
        const cookies = await context.cookies();
        const tokenCookie = cookies.find(
          (c) =>
            c.name === 'token' ||
            (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh')),
        );
        const refreshCookie = cookies.find(
          (c) => c.name === 'refresh_token' || (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen')),
        );
        if (tokenCookie?.value) capturedToken = tokenCookie.value;
        if (refreshCookie?.value) capturedRefresh = refreshCookie.value;
      } catch {
        logStore.log('warn', 'auth', `cookie read failed during poll for ${email}`);
      }
    }

    await page.unroute('**/api/v2/auths/signin');

    if (capturedToken) {
      return {
        token: capturedToken,
        expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
        refreshToken: capturedRefresh,
      };
    }

    const cookies = await context.cookies();
    logStore.log('warn', 'auth', `Temp context login failed for ${email}. Cookies: ${cookies.map((c) => c.name).join(', ')}`);
    return null;
  } catch (err: any) {
    logStore.log('error', 'auth', `Temp context login error for ${email}: ${err.message}`);
    return null;
  } finally {
    // Close the temp context to prevent BrowserContext leak. Each loginViaTempContext
    // call creates a new page+context via createAccountContext — without closing it,
    // contexts accumulate in the Playwright browser process, wasting memory.
    if (accCtx) {
      try {
        removeAccountContext(email);
      } catch {
        /* removeAccountContext handles interval clear, context close, and map cleanup */
      }
      try {
        await accCtx.page.close();
      } catch {
        /* page may already be closed */
      }
      try {
        await accCtx.context.close();
      } catch {
        /* context may already be closed or already closed by removeAccountContext */
      }
    }
    release();
  }
}

// ---------------------------------------------------------------------------
// Shared manual browser login for third-party providers (DeepSeek, GLM, etc.)
// ---------------------------------------------------------------------------

export interface ManualLoginOptions {
  loginUrl: string;
  /** Used for log messages */
  provider: string;
  /**
   * URL path segments that indicate still on the auth page.
   * Login is considered complete when the URL no longer contains any of these.
   */
  authPagePaths: string[];
  /**
   * Optional pre-fill actions (e.g., clicking "Continue with Email" for GLM).
   * Called after navigation to loginUrl, before the password fill attempt.
   */
  beforeFill?: (page: Page, email: string, password: string) => Promise<void>;
}

/**
 * Open a headed browser, let the user log in manually, capture cookies.
 * Returns ProviderAuthState on success, null on timeout or error.
 */
export async function manualBrowserLogin(email: string, password: string, opts: ManualLoginOptions): Promise<ProviderAuthState | null> {
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.goto(opts.loginUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Optional pre-fill setup (e.g., click "Continue with Email")
    if (opts.beforeFill) {
      await opts.beforeFill(page, email, password);
    }

    // Auto-fill credentials (best-effort) — human-like typing
    try {
      const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]');
      if (await emailInput.isVisible({ timeout: 8000 }).catch(() => false)) {
        await emailInput.click();
        await page.waitForTimeout(100 + Math.random() * 200);
        await emailInput.pressSequentially(email, { delay: 30 + Math.random() * 50 });
      }
      const passwordInput = page.locator('input[type="password"]');
      if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await page.waitForTimeout(100 + Math.random() * 150);
        await passwordInput.click();
        await page.waitForTimeout(100 + Math.random() * 150);
        await passwordInput.pressSequentially(password, { delay: 25 + Math.random() * 40 });
        await page.waitForTimeout(200 + Math.random() * 300);
      }
    } catch {
      // Form fill failed — user will do it manually
    }

    logStore.log('info', `${opts.provider}-login`, `Browser opened for ${email} at ${opts.loginUrl} — complete login manually`);

    // Wait up to 5 minutes for manual login
    const startTime = Date.now();
    const timeout = 5 * 60 * 1000;
    let loggedIn = false;

    while (Date.now() - startTime < timeout) {
      await page.waitForTimeout(3000);
      try {
        const currentUrl = page.url();
        // Login is complete when URL no longer contains any auth page path
        if (!opts.authPagePaths.some((p) => currentUrl.includes(p))) {
          loggedIn = true;
          break;
        }
      } catch {
        break; // Page was closed
      }
    }

    if (!loggedIn) {
      logStore.log('warn', `${opts.provider}-login`, `Manual login timed out for ${email}`);
      await browser.close();
      return null;
    }

    // Capture cookies as token
    const cookies = await context.cookies();
    const token = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await browser.close();

    return {
      token,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      refreshToken: null,
      lastLoginAttempt: Date.now(),
    };
  } catch (err: any) {
    logStore.log('error', `${opts.provider}-login`, `${opts.provider} manual login error for ${email}: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}
