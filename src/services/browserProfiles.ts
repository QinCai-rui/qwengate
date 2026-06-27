/*
 * File: browserProfiles.ts
 * Browser profile management extracted from playwright.ts.
 * Handles persistent browser profiles, auto-fill login, and token refresh via profiles.
 */

import { launchPersistentContext as cloakPersistentContext } from 'cloakbrowser';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Cookie } from 'playwright';
import { projectPath } from '../utils/paths.ts';
import { logStore } from './logStore.ts';

export function getProfileDir(email: string): string {
  const safe = email
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '_');
  const dir = projectPath('.auth', 'browser-profiles', safe);
  mkdirSync(dir, { recursive: true });
  // Set profile name to email so the Chrome window shows the account
  const prefsFile = `${dir}/Preferences`;
  const prefs: Record<string, any> = existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, 'utf-8')) : {};
  prefs.profile = { ...prefs.profile, name: email };
  writeFileSync(prefsFile, JSON.stringify(prefs), 'utf-8');
  return dir;
}

/** Remove stale Chrome singleton files that block new instances from starting on this profile. */
function cleanupSingletonLock(profileDir: string): void {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      const f = join(profileDir, name);
      if (existsSync(f)) rmSync(f, { recursive: true });
    } catch {
      // best effort
    }
  }
}

export type LoginResult = 'success' | 'captcha' | 'closed' | 'error';

export interface BrowserProfileOptions {
  headless?: boolean;
}

import { validateQwenUrl } from './playwright.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const BROWSER_DEFAULT_ARGS: readonly string[] = ['--no-sandbox', '--disable-setuid-sandbox', '--ozone-platform-hint=auto'];

function getBrowserArgs(): string[] {
  return [...BROWSER_DEFAULT_ARGS];
}

export async function setupBrowserContext(email: string, headless: boolean): Promise<any> {
  const profileDir = getProfileDir(email);
  cleanupSingletonLock(profileDir);
  return await cloakPersistentContext({
    userDataDir: profileDir,
    headless,
    humanize: true,
    geoip: true,
    viewport: { width: 1920, height: 1080 },
    args: getBrowserArgs(),
  });
}

async function checkExistingToken(context: any): Promise<boolean> {
  const existingCookies: Cookie[] = await context.cookies();
  const existingToken = existingCookies.find((c: Cookie) => c.name === 'token');
  return !!(existingToken && (!existingToken.expires || existingToken.expires <= 0 || existingToken.expires * 1000 > Date.now()));
}

export async function fillLoginForm(page: any, email: string, password: string): Promise<void> {
  try {
    await page.waitForSelector('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]', {
      timeout: 5000,
    });
    const emailInput = page.locator('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]').first();
    await emailInput.click();
    await sleep(100 + Math.random() * 200);
    await emailInput.pressSequentially(email, { delay: 30 + Math.random() * 50 });

    await sleep(100 + Math.random() * 150);
    await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 3000 });
    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    await passwordInput.click();
    await sleep(100 + Math.random() * 150);
    await passwordInput.pressSequentially(password, { delay: 25 + Math.random() * 40 });

    await sleep(200 + Math.random() * 300);
    try {
      const submitBtn = page
        .locator(
          'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in"), button:has-text("Continue")',
        )
        .first();
      await submitBtn.click({ timeout: 3000 });
    } catch {
      logStore.log('warn', 'browser', 'submit button click failed for fillLoginForm');
    }
  } catch {
    logStore.log('warn', 'browser', 'form fill failed - selector not found for fillLoginForm');
  }
}

async function detectCaptcha(page: any): Promise<boolean> {
  return await page.evaluate(() => {
    return !!(
      document.querySelector('iframe[src*="recaptcha"]') ||
      document.querySelector('iframe[src*="captcha"]') ||
      document.querySelector('[class*="captcha"]') ||
      document.querySelector('[id*="captcha"]') ||
      document.querySelector('.captcha-container') ||
      document.querySelector('[data-sitekey]') ||
      document.querySelector('.g-recaptcha') ||
      Array.from(document.querySelectorAll('iframe')).some((f) => /challenge|verify|captcha|recaptcha/i.test(f.src || ''))
    );
  });
}

async function tryCheckToken(context: any, email: string): Promise<LoginResult | null> {
  try {
    const cookies: Cookie[] = await context.cookies();
    const tokenCookie = cookies.find((c: Cookie) => c.name === 'token');
    if (!tokenCookie) return null;
    const { saveCookies } = await import('./auth.ts');
    const refreshCookie = cookies.find((c: Cookie) => c.name.toLowerCase().includes('refresh'));
    await saveCookies(email, tokenCookie.value, refreshCookie?.value);
    try {
      await context.close();
    } catch {
      logStore.log('warn', 'browser', 'context.close failed in tryCheckToken success');
    }
    return 'success';
  } catch {
    try {
      await context.close();
    } catch {
      logStore.log('warn', 'browser', 'context.close failed in tryCheckToken error');
    }
    return 'closed';
  }
}

async function tryCheckCaptcha(page: any, context: any, attempt: number): Promise<'captcha' | null> {
  if (attempt <= 0 || attempt % 3 !== 0) return null;
  try {
    const hasCaptcha = await detectCaptcha(page);
    if (!hasCaptcha) return null;
    return 'captcha';
  } catch {
    logStore.log('warn', 'browser', 'captcha detection failed in tryCheckCaptcha');
  }
  return null;
}

async function pollForToken(page: any, context: any, email: string): Promise<LoginResult | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(2000);

    const tokenResult = await tryCheckToken(context, email);
    if (tokenResult) return tokenResult;

    const captchaResult = await tryCheckCaptcha(page, context, attempt);
    if (captchaResult) return captchaResult;
  }
  return null;
}

export async function openBrowserProfile(email: string, password?: string, options?: BrowserProfileOptions): Promise<LoginResult> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'success' as LoginResult;

  const headless = options?.headless ?? false;
  let context: any = null;
  let page: any = null;

  try {
    logStore.log('info', 'browser', `Opening profile for ${email} (headless: ${headless})...`);
    context = await setupBrowserContext(email, headless);
    if (await checkExistingToken(context)) {
      logStore.log('info', 'browser', `Existing valid token found for ${email}`);
      await context.close();
      return 'success';
    }

    page = context.pages()[0] || (await context.newPage());

    logStore.log('info', 'browser', `Navigating to auth page for ${email}...`);
    validateQwenUrl('https://chat.qwen.ai/auth');
    await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (password) {
      logStore.log('info', 'browser', `Filling login form for ${email}...`);
      await fillLoginForm(page, email, password);
    }

    logStore.log('info', 'browser', `Polling for token for ${email}...`);
    const result = await pollForToken(page, context, email);
    if (result) {
      logStore.log('info', 'browser', `✓ Login successful for ${email}`);
      return result;
    }

    logStore.log('error', 'browser', `Headless timeout — no login detected for ${email}, closing browser`);
    try {
      await context.close();
    } catch {
      logStore.log('warn', 'browser', `context.close failed after timeout for ${email}`);
    }
    return 'error';
  } catch (err: any) {
    logStore.log('error', 'browser', `Error for ${email}: ${err.message}`);
    if (context) {
      try {
        await context.close();
      } catch {
        logStore.log('warn', 'browser', `context.close failed in outer catch for ${email}`);
      }
    }
    return 'error';
  }
}

export type AutoLoginOutcome =
  | { status: 'success'; cookieStr: string; token: string; expiresAt: number; wafToken?: string; captchaVerifyParam?: string }
  | { status: 'captcha' | 'closed' | 'error' };

export interface AutoLoginOptions {
  provider?: 'qwen' | 'deepseek' | 'glm';
  authUrl: string;
  authPagePaths: string[];
  beforeFill?: (page: any) => Promise<void>;
  /** If true, capture the provider-specific token (Bearer for DeepSeek, JWT for GLM) instead of just cookies. */
  extractToken?: boolean;
}

/**
 * Extract the provider-specific auth token from a browser context.
 * Returns the Bearer token for DeepSeek, JWT for GLM, or cookie string for Qwen.
 */
export async function extractProviderToken(
  context: any,
  page: any,
  provider: 'qwen' | 'deepseek' | 'glm' | undefined,
): Promise<{ token: string; expiresAt: number; wafToken?: string; captchaVerifyParam?: string } | null> {
  if (!provider || provider === 'qwen') {
    // Qwen: use cookies (existing behavior)
    const cookies = await context.cookies();
    const cookieStr = cookies
      .filter((c: any) => c.value)
      .map((c: any) => `${c.name}=${c.value}`)
      .join('; ');
    const expiresAt =
      cookies.reduce((latest: number, c: any) => Math.max(latest, c.expires ? c.expires * 1000 : 0), 0) ||
      Date.now() + 7 * 24 * 60 * 60 * 1000;
    return { token: cookieStr, expiresAt };
  }

  if (provider === 'deepseek') {
    // DeepSeek: fetch Bearer token from /api/v0/users/current + extract aws-waf-token cookie
    try {
      const result = await page.evaluate(async () => {
        const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
          credentials: 'include',
        });
        if (!res.ok) return null;
        const data = await res.json();
        const token = data?.data?.biz_data?.token || null;
        // Extract aws-waf-token from cookies
        const wafCookie = document.cookie.split('; ').find((c) => c.startsWith('aws-waf-token='));
        const wafToken = wafCookie ? wafCookie.split('=')[1] : null;
        return { token, wafToken };
      });
      if (result?.token) {
        return { token: result.token, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, wafToken: result.wafToken };
      }
    } catch (err: any) {
      logStore.log('warn', 'browser', `Failed to extract DeepSeek token: ${err.message}`);
    }
    return null;
  }

  if (provider === 'glm') {
    // GLM: read JWT from token cookie
    try {
      const cookies = await context.cookies();
      const tokenCookie = cookies.find((c: any) => c.name === 'token' && (c.domain.includes('z.ai') || c.domain.includes('chatglm')));
      if (tokenCookie?.value) {
        return { token: tokenCookie.value, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 };
      }
    } catch (err: any) {
      logStore.log('warn', 'browser', `Failed to extract GLM token: ${err.message}`);
    }
    return null;
  }

  return null;
}

async function buildCookieFallback(context: any): Promise<{ cookieStr: string; expiresAt: number }> {
  const cookies = await context.cookies();
  const cookieStr = cookies
    .filter((c: any) => c.value)
    .map((c: any) => `${c.name}=${c.value}`)
    .join('; ');
  const expiresAt =
    cookies.reduce((latest: number, c: any) => Math.max(latest, c.expires && c.expires > 0 ? c.expires * 1000 : 0), 0) ||
    Date.now() + 7 * 24 * 60 * 60 * 1000;
  return { cookieStr, expiresAt };
}

export async function autoLoginViaBrowser(email: string, password: string | undefined, opts: AutoLoginOptions): Promise<AutoLoginOutcome> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return { status: 'success', cookieStr: '', token: '', expiresAt: Date.now() + 3600000 };
  }

  let context: any = null;
  try {
    context = await setupBrowserContext(email, true); // headless:true — stealth stealth

    // Check existing valid session first
    const existingCookies: any[] = await context.cookies();
    const hasAuthCookie = existingCookies.some(
      (c: any) =>
        c.value &&
        (c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session') || c.name.toLowerCase().includes('auth')),
    );
    const allValid = existingCookies.every((c: any) => {
      if (!c.expires || c.expires <= 0) return true; // session cookie = valid
      return c.expires * 1000 > Date.now(); // check expiry
    });
    if (hasAuthCookie && allValid) {
      // Extract provider-specific token if requested
      const existingPage = context.pages()[0] || (await context.newPage().catch(() => null));
      const tokenResult = await extractProviderToken(context, existingPage, opts.provider);
      const cookieStr = existingCookies
        .filter((c: any) => c.value)
        .map((c: any) => `${c.name}=${c.value}`)
        .join('; ');
      const expiresAt =
        existingCookies.reduce((latest: number, c: any) => Math.max(latest, c.expires && c.expires > 0 ? c.expires * 1000 : 0), 0) ||
        Date.now() + 7 * 24 * 60 * 60 * 1000;
      await context.close().catch(() => {});
      logStore.log('info', 'browser', `Existing valid session for ${email} — skipping auto-login`);
      return {
        status: 'success',
        cookieStr,
        token: tokenResult?.token || cookieStr,
        expiresAt: tokenResult?.expiresAt || expiresAt,
        wafToken: tokenResult?.wafToken,
        captchaVerifyParam: tokenResult?.captchaVerifyParam,
      };
    }

    // Create fresh page
    const pages = context.pages();
    const page = await context.newPage();
    for (const p of pages) await p.close().catch(() => {});

    logStore.log('info', 'browser', `Navigating to ${opts.authUrl} for ${email}...`);
    await page.goto(opts.authUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    // Before-fill callback (e.g., click "Continue with Email" for GLM)
    if (opts.beforeFill) {
      await opts.beforeFill(page);
    }

    // Auto-fill credentials
    if (password) {
      logStore.log('info', 'browser', `Filling login form for ${email}...`);
      // Use fillLoginForm from same file (already imported/available)
      await fillLoginForm(page, email, password);
    }

    logStore.log('info', 'browser', `Polling for token for ${email}...`);
    // Poll for success — URL change OR auth cookies
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(2000);

      // Check URL change (navigated away from auth page)
      try {
        const currentUrl = page.url();
        if (!opts.authPagePaths.some((p: string) => currentUrl.includes(p))) {
          // Extract provider-specific token
          const tokenResult = await extractProviderToken(context, page, opts.provider);
          if (tokenResult) {
            await context.close().catch(() => {});
            logStore.log('info', 'browser', `✓ Auto-login success for ${email}`);
            return {
              status: 'success',
              cookieStr: '',
              token: tokenResult.token,
              expiresAt: tokenResult.expiresAt,
              wafToken: tokenResult.wafToken,
              captchaVerifyParam: tokenResult.captchaVerifyParam,
            };
          }
          // Fallback: use cookies
          const fallback = await buildCookieFallback(context);
          await context.close().catch(() => {});
          logStore.log('info', 'browser', `✓ Auto-login success for ${email}`);
          return { status: 'success', cookieStr: fallback.cookieStr, token: fallback.cookieStr, expiresAt: fallback.expiresAt };
        }
      } catch {
        break;
      }

      // Check cookies directly (fallback)
      const currentCookies: any[] = await context.cookies();
      const hasAuth = currentCookies.some(
        (c: any) =>
          c.value &&
          (c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session') || c.name.toLowerCase().includes('auth')),
      );
      if (hasAuth) {
        // Extract provider-specific token
        const tokenResult = await extractProviderToken(context, page, opts.provider);
        if (tokenResult) {
          await context.close().catch(() => {});
          logStore.log('info', 'browser', `✓ Auto-login success (cookie-based) for ${email}`);
          return {
            status: 'success',
            cookieStr: '',
            token: tokenResult.token,
            expiresAt: tokenResult.expiresAt,
            wafToken: tokenResult.wafToken,
            captchaVerifyParam: tokenResult.captchaVerifyParam,
          };
        }
        // Fallback: use cookies
        const fallback = await buildCookieFallback(context);
        await context.close().catch(() => {});
        logStore.log('info', 'browser', `✓ Auto-login success (cookie-based) for ${email}`);
        return { status: 'success', cookieStr: fallback.cookieStr, token: fallback.cookieStr, expiresAt: fallback.expiresAt };
      }

      // Check for captcha every 3 attempts
      if (attempt > 0 && attempt % 3 === 0) {
        try {
          const hasCaptcha = await detectCaptcha(page);
          if (hasCaptcha) {
            logStore.log('warn', 'browser', `Captcha detected for ${email} — falling back to manual`);
            await context.close().catch(() => {});
            return { status: 'captcha' };
          }
        } catch {
          /* captcha detection failed non-critical */
        }
      }
    }

    // Timed out — probably bot detection
    logStore.log('warn', 'browser', `Auto-login timed out for ${email} — likely bot detection`);
    await context.close().catch(() => {});
    return { status: 'captcha' };
  } catch (err: any) {
    logStore.log('error', 'browser', `Auto-login error for ${email}: ${err.message}`);
    if (context) await context.close().catch(() => {});
    return { status: 'error' };
  }
}

/**
 * Load a valid session from the persistent browser profile without re-logging in.
 * Opens the profile headlessly, checks for valid auth cookies/localStorage,
 * and returns the token if found.
 *
 * For DeepSeek: reads `localStorage.userToken.value` from chat.deepseek.com
 * For GLM: reads the `token` cookie from chat.z.ai
 * For Qwen: uses the existing cookie-based check
 *
 * Returns null if no valid session found — caller should then do auto-login.
 */
export async function loadSessionFromProfile(
  email: string,
  provider: 'qwen' | 'deepseek' | 'glm',
): Promise<{ token: string; expiresAt: number } | null> {
  let context: any = null;
  try {
    context = await setupBrowserContext(email, true); // headless: true — no UI

    if (provider === 'deepseek') {
      // DeepSeek: token is in localStorage.userToken
      const page = await context.newPage();
      try {
        await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
        const result = await page.evaluate(() => {
          try {
            const raw = localStorage.getItem('userToken');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed?.value || null;
          } catch {
            return null;
          }
        });
        if (result && typeof result === 'string' && result.length > 20) {
          logStore.log('info', 'browser', `Loaded DeepSeek token from profile localStorage for ${email}`);
          await context.close().catch(() => {});
          return { token: result, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
        }
      } finally {
        await page.close().catch(() => {});
      }
    } else if (provider === 'glm') {
      // GLM: token is in the `token` cookie (HttpOnly, set on chat.z.ai domain)
      const cookies = await context.cookies('https://chat.z.ai');
      const tokenCookie = cookies.find((c: any) => c.name === 'token' && c.value);
      if (tokenCookie?.value) {
        // Validate the JWT is not expired
        try {
          const payload = JSON.parse(atob(tokenCookie.value.split('.')[1]));
          if (payload.exp && payload.exp * 1000 < Date.now()) {
            logStore.log('warn', 'browser', `GLM JWT expired for ${email} — needs re-login`);
            await context.close().catch(() => {});
            return null;
          }
        } catch {
          // Can't decode — assume valid, GLM tokens don't expire per payload
        }
        logStore.log('info', 'browser', `Loaded GLM JWT from profile cookie for ${email}`);
        await context.close().catch(() => {});
        return { token: tokenCookie.value, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 };
      }
    } else {
      // Qwen: existing cookie-based check
      const cookies = await context.cookies();
      const authCookie = cookies.find(
        (c: any) => c.name === 'token' && c.value && (!c.expires || c.expires <= 0 || c.expires * 1000 > Date.now()),
      );
      if (authCookie?.value) {
        const expiresAt = authCookie.expires && authCookie.expires > 0 ? authCookie.expires * 1000 : Date.now() + 7 * 24 * 60 * 60 * 1000;
        logStore.log('info', 'browser', `Loaded Qwen token from profile cookie for ${email}`);
        await context.close().catch(() => {});
        return { token: authCookie.value, expiresAt };
      }
    }

    await context.close().catch(() => {});
    return null;
  } catch (err: any) {
    logStore.log('warn', 'browser', `loadSessionFromProfile failed for ${email} (${provider}): ${err.message}`);
    if (context) await context.close().catch(() => {});
    return null;
  }
}

async function refreshViaProfile(email: string): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true;

  const profileDir = getProfileDir(email);
  let context: any = null;

  try {
    context = await cloakPersistentContext({
      userDataDir: profileDir,
      headless: true,
      humanize: true,
      geoip: true,
      args: [...BROWSER_DEFAULT_ARGS],
    });

    const page = context.pages()[0] || (await context.newPage());
    validateQwenUrl('https://chat.qwen.ai');
    await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });

    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(1500);
      const cookies: Cookie[] = await context.cookies();
      const tokenCookie = cookies.find((c: Cookie) => c.name === 'token');
      if (tokenCookie && tokenCookie.expires && tokenCookie.expires * 1000 > Date.now()) {
        const { saveCookies } = await import('./auth.ts');
        const refreshCookie = cookies.find((c: Cookie) => c.name.toLowerCase().includes('refresh'));
        await saveCookies(email, tokenCookie.value, refreshCookie?.value);
        try {
          await context.close();
        } catch {
          logStore.log('warn', 'browser', `context.close failed after token save for ${email}`);
        }
        return true;
      }
    }

    logStore.log('error', 'browser', `No valid token found after profile navigation for ${email}`);
    try {
      await context.close();
    } catch {
      logStore.log('warn', 'browser', `context.close failed after navigation for ${email}`);
    }
    return false;
  } catch (err: any) {
    logStore.log('error', 'browser', `Profile refresh error for ${email}: ${err.message}`);
    if (context) {
      try {
        await context.close();
      } catch {
        logStore.log('warn', 'browser', `context.close failed in outer catch for ${email}`);
      }
    }
    return false;
  }
}

/**
 * Extract GLM captcha_verify_param from a fresh browser page.
 * Navigates to chat.z.ai, waits for the Aliyun captcha SDK to initialize,
 * and captures the captcha_verify_param from the page's first /api/v2/chat/completions request
 * or from a global variable set by the Aliyun SDK.
 */
export async function extractGlmCaptchaFields(page: any): Promise<{ captchaVerifyParam?: string }> {
  try {
    await page.goto('https://chat.z.ai', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});

    const captchaVerifyParam = await page.evaluate(async () => {
      return new Promise<string | null>((resolve) => {
        let resolved = false;
        const done = (val: string | null) => {
          if (resolved) return;
          resolved = true;
          resolve(val);
        };

        // Strategy 1: intercept fetch calls to /chat/completions
        const origFetch = window.fetch.bind(window);
        window.fetch = function (url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          try {
            const urlStr = typeof url === 'string' ? url : url.toString();
            if (urlStr.includes('/api/v2/chat/completions') && init?.body) {
              const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
              if (body.captcha_verify_param) {
                done(body.captcha_verify_param);
              }
            }
          } catch {
            /* ignore parse errors */
          }
          return origFetch(url, init);
        } as typeof window.fetch;

        // Strategy 2: poll for globals set by Aliyun captcha SDK
        let pollCount = 0;
        const poll = setInterval(() => {
          pollCount++;
          for (const key of ['captchaVerifyParam', '__captchaVerifyParam']) {
            const val = (window as any)[key];
            if (val && typeof val === 'string' && val.length > 50) {
              clearInterval(poll);
              done(val);
              return;
            }
          }
          if (pollCount > 30) {
            // 30 * 500ms = 15s timeout
            clearInterval(poll);
            done(null);
          }
        }, 500);
      });
    });

    if (captchaVerifyParam) {
      return { captchaVerifyParam };
    }
  } catch (err: any) {
    logStore.log('warn', 'browser', `Failed to extract GLM captcha fields: ${err.message}`);
  }

  return {};
}
