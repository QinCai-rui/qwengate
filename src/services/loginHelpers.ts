/*
 * File: loginHelpers.ts
 * Login implementation helpers extracted from auth.ts.
 * Contains the three login strategies: browser context, fetch, and temp context.
 */

import crypto from 'crypto';
import { getActivePage, getBrowser, createAccountContext } from './playwright.ts';
import type { AuthState } from './auth.ts';
import { AUTH_TOKEN_MAX_AGE_MS, createAuthFetchTimeout, checkPlaywrightSession } from './auth.ts';

export class LoginMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
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

/**
 * Login via browser context — executes signin API inside the browser via evaluate().
 */
export async function loginFreshViaBrowser(
  email: string,
  hashedPassword: string,
  loginMutex: LoginMutex,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const page = getActivePage();
    if (!page) return null;

    try {
      const currentUrl = page.url();
      if (!currentUrl.startsWith('https://chat.qwen.ai')) {
        await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded' });
      }
    } catch (err: any) {
      console.warn(`[Auth] Navigation check failed for ${email}: ${err.message}`);
    }

    try {
      const context = page.context();
      const existingCookies = await context.cookies();
      const authCookies = existingCookies.filter(c =>
        c.name === 'token' ||
        c.name === 'refresh_token' ||
        c.name.toLowerCase().includes('session') ||
        c.name.toLowerCase().includes('token')
      );
      if (authCookies.length > 0) {
        await context.clearCookies();
      }
    } catch (err: any) {
      console.warn(`[Auth] Cookie clearing failed for ${email}: ${err.message}`);
    }

    let evalResult: { ok: boolean; status: number; token: string | null; refreshToken: string | null; dataKeys: string[] };
    try {
      evalResult = await page.evaluate(async ({ email, hashedPassword }: { email: string; hashedPassword: string }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);
        let response: Response;
        try {
          response = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
            method: 'POST',
            headers: {
              'accept': 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'source': 'web',
              'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
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
        try { data = await response.json(); } catch {
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
      }, { email, hashedPassword });
    } catch (err: any) {
      console.error(`[Auth] Browser evaluate failed for ${email}: ${err.message}`);
      return null;
    }

    if (!evalResult.ok) {
      console.error(`[Auth] Login failed for ${email} (${evalResult.status})`);
      return null;
    }

    let cookieToken: string | null = null;
    let cookieRefresh: string | null = null;
    try {
      const cookies = await page.context().cookies();
      const tokenCookie = cookies.find(c =>
        c.name === 'token' ||
        (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh'))
      );
      const refreshCookie = cookies.find(c =>
        c.name === 'refresh_token' ||
        (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen'))
      );
      cookieToken = tokenCookie?.value || null;
      cookieRefresh = refreshCookie?.value || null;
    } catch (err: any) {
      console.warn(`[Auth] Cookie read failed for ${email}: ${err.message}`);
    }

    const finalToken = evalResult.token || cookieToken;
    const finalRefresh = evalResult.refreshToken || cookieRefresh;

    if (finalToken) {
      return {
        token: finalToken,
        expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
        refreshToken: finalRefresh,
      };
    }

    console.warn(
      `[Auth] Login returned 200 for ${email} but no token found. ` +
      `Response keys: [${evalResult.dataKeys.join(', ')}]. ` +
      `No auth cookies captured.`
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
  const { controller, cleanup: _cleanup } = createAuthFetchTimeout();
  try {
    const response = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'source': 'web',
        'Version': '0.2.57',
        'bx-v': '2.5.36',
        'Referer': 'https://chat.qwen.ai/auth',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ email, password: hashedPassword }),
      signal: controller.signal,
    });

    if (response.ok) {
      let data: any;
      try { data = await response.json(); } catch { data = {}; }

      let token = data.data?.token || data.token || data.data?.session_token || null;
      let refreshToken = data.data?.refresh_token || data.refresh_token || null;

      if (!token) {
        const hdrs = response.headers as Headers & { getSetCookie?: () => string[] };
        const setCookies: string[] = typeof hdrs.getSetCookie === 'function'
          ? hdrs.getSetCookie()
          : (response.headers.get('set-cookie') || '').split(',');

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
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken,
        };
      }

      const hasPlaywrightSession = await checkPlaywrightSession();
      if (hasPlaywrightSession) {
        return {
          token: '',
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken: null,
        };
      }

      console.warn(`[Auth] API login returned 200 but no token for ${email}:`, JSON.stringify(data).substring(0, 200));
    } else {
      const errText = await response.text();
      console.error(`[Auth] Login failed for ${email} (${response.status}): ${errText.substring(0, 200)}`);
    }
  } catch (err: any) {
    console.error(`[Auth] Login error for ${email}: ${err.message}`);
  }

  return null;
}

export async function loginViaTempContext(
  _browser: ReturnType<typeof getBrowser>,
  email: string,
  rawPassword: string,
  loginMutex: LoginMutex,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const accCtx = await createAccountContext(email);
    const page = accCtx.page;
    const context = accCtx.context;

    let capturedToken: string | null = null;
    let capturedRefresh: string | null = null;

    await page.route('**/api/v2/auths/signin', async (route) => {
      const response = await route.fetch();
      const setCookies = response.headersArray()
        .filter(h => h.name.toLowerCase() === 'set-cookie')
        .map(h => h.value);
      for (const cookie of setCookies) {
        const tokenMatch = cookie.match(/\btoken=([^;]+)/);
        if (tokenMatch && !capturedToken) capturedToken = tokenMatch[1];
        const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
        if (refreshMatch) capturedRefresh = refreshMatch[1];
      }
      await route.fulfill({ response });
    });

    try {
      await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      // non-blocking
    }

    try {
      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15_000 });
      await page.fill('input[type="email"], input[name="email"]', email);
      await page.fill('input[type="password"], input[name="password"]', rawPassword);
      await Promise.all([
        page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")'),
        page.waitForURL(url => !url.toString().includes('/auth'), { timeout: 15_000 }).catch(() => {}),
      ]);
    } catch {
      // non-blocking
    }

    await new Promise(r => setTimeout(r, 2000));

    if (!capturedToken) {
      const cookies = await context.cookies();
      const tokenCookie = cookies.find(c =>
        c.name === 'token' ||
        (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh'))
      );
      const refreshCookie = cookies.find(c =>
        c.name === 'refresh_token' ||
        (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen'))
      );
      capturedToken = tokenCookie?.value || null;
      capturedRefresh = refreshCookie?.value || null;
    }

    await page.unroute('**/api/v2/auths/signin');

    if (capturedToken) {
      return {
        token: capturedToken,
        expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
        refreshToken: capturedRefresh,
      };
    }

    const cookies = await context.cookies();
    console.warn(
      `[Auth] Temp context login failed for ${email}. Cookies: ${cookies.map(c => c.name).join(', ')}`
    );
    return null;
  } catch (err: any) {
    console.error(`[Auth] Temp context login error for ${email}: ${err.message}`);
    return null;
  } finally {
    release();
  }
}
