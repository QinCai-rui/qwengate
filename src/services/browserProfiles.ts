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
  const dir = projectPath('.auth', 'account-profile', safe);
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
  fillOnly?: boolean;
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

export async function fillLoginForm(page: any, email: string, password: string, skipSubmit?: boolean): Promise<void> {
  try {
    // Use broad selectors for email/username input — some sites use type="text" or type="tel" (e.g. DeepSeek: "Phone number / email address")
    await page.waitForSelector(
      'input[type="email"], input[placeholder*="email" i], input[placeholder*="Email"], input[placeholder*="phone" i], input[name="email"], input[name="login"], input[name="identifier"], input[type="text"]:not([type="password"]):not([type="hidden"]):not([type="search"])',
      { timeout: 8000 },
    );
    const emailInput = page
      .locator(
        'input[type="email"], input[placeholder*="email" i], input[placeholder*="Email"], input[placeholder*="phone" i], input[name="email"], input[name="login"], input[name="identifier"], input[type="text"]:not([type="password"]):not([type="hidden"]):not([type="search"])',
      )
      .first();
    await emailInput.click();
    await sleep(100 + Math.random() * 200);
    await emailInput.pressSequentially(email, { delay: 30 + Math.random() * 50 });

    await sleep(100 + Math.random() * 150);
    await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 5000 });
    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    await passwordInput.click();
    await sleep(100 + Math.random() * 150);
    await passwordInput.pressSequentially(password, { delay: 25 + Math.random() * 40 });

    await sleep(200 + Math.random() * 300);
    try {
      const submitBtn = page
        .locator(
          'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in"), button:has-text("Continue"), button:has-text("Submit")',
        )
        .first();
      const isVisible = await submitBtn.isVisible({ timeout: 2000 }).catch(() => false);
      if (isVisible && !skipSubmit) {
        await submitBtn.click({ timeout: 3000 });
      } else if (!skipSubmit) {
        // Fallback: press Enter on the password field
        await page.keyboard.press('Enter');
      }
    } catch {
      if (!skipSubmit) {
        // ponytail: pressing Enter is the universal fallback for any login form
        await page.keyboard.press('Enter').catch(() => {});
      }
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
  /** If true, only use existing session — never attempt fresh login (e.g. GLM triggers captcha). */
  skipFreshLogin?: boolean;
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
    // DeepSeek: two extraction strategies
    // 1. localStorage.userToken (fast, but may be stale)
    // 2. Fetch-based via browser context using SSO session cookies (returns fresh token)
    try {
      // Navigate to chat.deepseek.com first — needed for both strategies
      await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      // Allow SPA to initialize and potentially refresh the token
      await sleep(5000);

      // Strategy 1: read from localStorage.userToken
      const lsResult = await page.evaluate(() => {
        try {
          const raw = localStorage.getItem('userToken');
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          const token = parsed?.value || null;
          // aws-waf-token from document.cookie (non-HttpOnly)
          const cookies = document.cookie.split('; ');
          const wafCookie = cookies.find((c) => c.trim().startsWith('aws-waf-token='));
          const wafToken = wafCookie ? wafCookie.split('=').slice(1).join('=') : null;
          return { token, wafToken };
        } catch {
          return null;
        }
      });

      // Validate localStorage token server-side
      if (lsResult?.token) {
        const valid = await (async () => {
          try {
            const r = await fetch('https://chat.deepseek.com/api/v0/users/current', {
              headers: { Authorization: `Bearer ${lsResult.token}` },
              signal: AbortSignal.timeout(10000),
            });
            return r.ok;
          } catch {
            return false;
          }
        })();
        if (valid) {
          return { token: lsResult.token, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, wafToken: lsResult.wafToken };
        }
        logStore.log('warn', 'browser', 'DeepSeek localStorage token expired — trying fetch-based extraction');
      }

      // Strategy 2: fetch /api/v0/users/current from the browser context with credentials.
      // The SSO session cookies are automatically included.
      const fetchResult = await page.evaluate(async () => {
        try {
          const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
            credentials: 'include',
          });
          const status = res.status;
          if (!res.ok) return { error: `http_${status}`, statusText: res.statusText };
          const data = await res.json();
          // Try all known response paths for the token
          const token = data?.data?.biz_data?.token || data?.data?.token || data?.biz_data?.token || data?.token || null;
          const wafCookie = (document.cookie || '').split('; ').find((c) => c.trim().startsWith('aws-waf-token='));
          const wafToken = wafCookie ? wafCookie.split('=').slice(1).join('=') : null;
          return { token, wafToken, debug_keys: Object.keys(data?.data || {}).join(',') };
        } catch (e: any) {
          return { error: 'exception_' + (e?.message || 'unknown').slice(0, 120) };
        }
      });

      if (fetchResult && 'error' in fetchResult) {
        logStore.log('warn', 'browser', `DeepSeek fetch extraction error: ${(fetchResult as any).error}`);
      }

      if (fetchResult?.token) {
        // Validate fetch-extracted token server-side
        const valid = await (async () => {
          try {
            const r = await fetch('https://chat.deepseek.com/api/v0/users/current', {
              headers: { Authorization: `Bearer ${fetchResult.token}` },
              signal: AbortSignal.timeout(10000),
            });
            return r.ok;
          } catch {
            return true; // proceed if we can't validate — better than nothing
          }
        })();
        if (valid) {
          return { token: fetchResult.token, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, wafToken: fetchResult.wafToken };
        }
        logStore.log('warn', 'browser', 'DeepSeek fetch-extracted token also invalid');
      }

      logStore.log('warn', 'browser', 'All DeepSeek token extraction strategies failed');
    } catch (err: any) {
      logStore.log('warn', 'browser', `Failed to extract DeepSeek token: ${err.message}`);
    }
    return null;
  }

  if (provider === 'glm') {
    // GLM: read JWT from token cookie and captcha_verify_param from the page
    try {
      const cookies = await context.cookies();
      const tokenCookie = cookies.find((c: any) => c.name === 'token' && (c.domain.includes('z.ai') || c.domain.includes('chatglm')));
      if (tokenCookie?.value) {
        // Try to extract captcha_verify_param from the page (if available)
        let captchaVerifyParam: string | undefined;
        try {
          if (page) {
            await page.goto('https://chat.z.ai', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 5000));
            captchaVerifyParam = await page.evaluate(() => {
              const globals = [
                'captchaVerifyParam',
                '__captchaVerifyParam',
                'CAPTCHA_VERIFY_PARAM',
                'aliyunCaptchaVerifyParam',
                'AWSC_verifyParam',
              ];
              for (const key of globals) {
                try {
                  const val = (window as any)[key];
                  if (val && typeof val === 'string' && val.length > 10) return val;
                } catch {}
              }
              try {
                const awsc = (window as any).AWSC;
                if (awsc?.nc?.getVerifyParam) {
                  const param = awsc.nc.getVerifyParam();
                  if (param) return param;
                }
              } catch {}
              try {
                for (let i = 0; i < localStorage.length; i++) {
                  const k = localStorage.key(i);
                  if (k && k.toLowerCase().includes('captcha')) {
                    const v = localStorage.getItem(k);
                    if (v && v.length > 10) return v;
                  }
                }
              } catch {}
              try {
                const scripts = document.querySelectorAll('script:not([src])');
                for (const s of scripts) {
                  const text = s.textContent || '';
                  const m1 = text.match(/["']captcha_verify_param["']\s*:\s*["']([^"']{10,})["']/);
                  if (m1) return m1[1];
                  const m2 = text.match(/captchaVerifyParam\s*[:=]\s*["']([^"']{10,})["']/);
                  if (m2) return m2[1];
                }
              } catch {}
              try {
                const nd = (window as any).__NEXT_DATA__;
                if (nd) {
                  const json = JSON.stringify(nd);
                  const m = json.match(/captcha_verify_param["']:\s*["']([^"']{10,})["']/);
                  if (m) return m[1];
                }
              } catch {}
              return null;
            });
          }
        } catch {
          // Non-critical
        }
        // Persist captchaVerifyParam to localStorage so it survives browser profile restarts
        if (captchaVerifyParam && page) {
          try {
            await page.evaluate((val: string) => {
              localStorage.setItem('opengate_captchaVerifyParam', val);
            }, captchaVerifyParam);
          } catch {
            // Non-critical
          }
        }
        return {
          token: tokenCookie.value,
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
          captchaVerifyParam,
        };
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
      // For Qwen (cookie-based auth), cookie fallback works.
      // For DeepSeek/GLM (token-based auth), only fast-path when we have a valid provider-specific token.
      if (opts.provider === 'qwen' || tokenResult?.token) {
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
      // No valid provider-specific token — proceed with fresh login
      if (opts.skipFreshLogin) {
        await context.close().catch(() => {});
        logStore.log(
          'warn',
          'browser',
          `No existing ${opts.provider} session for ${email} and skipFreshLogin is set — user must login manually`,
        );
        return { status: 'captcha' };
      }
      logStore.log(
        'info',
        'browser',
        `Existing cookies found but no valid ${opts.provider} token for ${email} — proceeding with fresh login`,
      );
    } else if (opts.skipFreshLogin) {
      // No auth cookies at all and skipFreshLogin is set — don't attempt fresh login
      await context.close().catch(() => {});
      logStore.log(
        'warn',
        'browser',
        `No existing ${opts.provider} session for ${email} and skipFreshLogin is set — user must login manually`,
      );
      return { status: 'captcha' };
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
          // Cookie fallback only works for Qwen (cookie-based auth).
          // DeepSeek/GLM need a proper bearer token — if extraction failed, don't fall back to cookies.
          if (opts.provider === 'qwen') {
            const fallback = await buildCookieFallback(context);
            await context.close().catch(() => {});
            logStore.log('info', 'browser', `✓ Auto-login success for ${email}`);
            return { status: 'success', cookieStr: fallback.cookieStr, token: fallback.cookieStr, expiresAt: fallback.expiresAt };
          }
          logStore.log('warn', 'browser', `URL changed but no valid ${opts.provider} token for ${email} — continuing polling`);
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
        // Cookie fallback only works for Qwen
        if (opts.provider === 'qwen') {
          const fallback = await buildCookieFallback(context);
          await context.close().catch(() => {});
          logStore.log('info', 'browser', `✓ Auto-login success (cookie-based) for ${email}`);
          return { status: 'success', cookieStr: fallback.cookieStr, token: fallback.cookieStr, expiresAt: fallback.expiresAt };
        }
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
): Promise<{ token: string; expiresAt: number; cookieStr?: string } | null> {
  let context: any = null;
  try {
    context = await setupBrowserContext(email, true); // headless: true — no UI

    if (provider === 'deepseek') {
      // DeepSeek: token is in localStorage.userToken, cookies include aws-waf-token
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
          // Extract all cookies from the context (includes aws-waf-token)
          const cookies = await context.cookies('https://chat.deepseek.com');
          const cookieStr = cookies
            .filter((c: any) => c.value)
            .map((c: any) => `${c.name}=${c.value}`)
            .join('; ');
          logStore.log('info', 'browser', `Loaded DeepSeek token from profile localStorage for ${email} (${cookies.length} cookies)`);
          await context.close().catch(() => {});
          return { token: result, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, cookieStr };
        }
      } finally {
        await page.close().catch(() => {});
      }

      // No DeepSeek token found — try headless auto-login to populate profile
      await context.close().catch(() => {});
      context = null;

      try {
        // Get password from auth files
        let password = '';
        try {
          for (const authFile of [projectPath('.auth', 'auth.deepseek.json'), projectPath('.auth', 'auth.qwen.json')]) {
            if (!existsSync(authFile)) continue;
            const entries = JSON.parse(readFileSync(authFile, 'utf-8'));
            const entry = entries.find((e: any) => e.email.toLowerCase().trim() === email.toLowerCase().trim());
            if (entry?.password) {
              password = entry.password;
              break;
            }
          }
        } catch {
          /* ignore */
        }

        if (password) {
          const outcome = await autoLoginViaBrowser(email, password, {
            provider: 'deepseek',
            authUrl: 'https://chat.deepseek.com/',
            authPagePaths: ['/auth', '/login'],
          });

          if (outcome.status === 'success' && outcome.token) {
            logStore.log('info', 'browser', `Auto-logged in DeepSeek for ${email} — retrying profile load`);

            // Re-read from profile (auto-login saved to persistent profile)
            context = await setupBrowserContext(email, true);
            const retryPage = await context.newPage();
            await retryPage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
            const retryResult = await retryPage.evaluate(() => {
              try {
                const raw = localStorage.getItem('userToken');
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                return parsed?.value || null;
              } catch {
                return null;
              }
            });
            await retryPage.close().catch(() => {});

            if (retryResult && typeof retryResult === 'string' && retryResult.length > 20) {
              const dsCookies = await context.cookies('https://chat.deepseek.com');
              const dsCookieStr = dsCookies
                .filter((c: any) => c.value)
                .map((c: any) => `${c.name}=${c.value}`)
                .join('; ');
              logStore.log('info', 'browser', `Loaded DeepSeek token from profile localStorage for ${email} (${dsCookies.length} cookies)`);
              await context.close().catch(() => {});
              return { token: retryResult, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, cookieStr: dsCookieStr };
            }
          }
        }
      } catch (err: any) {
        logStore.log('warn', 'browser', `DeepSeek auto-login failed for ${email}: ${err.message}`);
      }
    } else if (provider === 'glm') {
      // GLM: token is in the `token` cookie (HttpOnly, set on chat.z.ai domain)
      const cookies = await context.cookies('https://chat.z.ai');
      let tokenCookie = cookies.find((c: any) => c.name === 'token' && c.value);

      // If no GLM token in profile, skip — user clicks Login button in dashboard
      if (!tokenCookie?.value) {
        await context.close().catch(() => {});
        logStore.log('info', 'browser', `No GLM token in profile for ${email} — use Login button to authenticate`);
        return null;
      }

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

      // Build the full cookie string from all browser cookies
      const cookieStr = cookies
        .filter((c: any) => c.value)
        .map((c: any) => `${c.name}=${c.value}`)
        .join('; ');

      logStore.log('info', 'browser', `Loaded GLM JWT from profile cookie for ${email}`);
      await context.close().catch(() => {});
      return {
        token: tokenCookie.value,
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        cookieStr,
      };
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

    // Allow time for captcha SDK scripts to initialize
    await sleep(5000);

    const captchaVerifyParam = await page.evaluate(() => {
      // Strategy 1: check common global variable names set by Aliyun captcha SDK
      const globals = [
        'captchaVerifyParam',
        '__captchaVerifyParam',
        'CAPTCHA_VERIFY_PARAM',
        'aliyunCaptchaVerifyParam',
        'AWSC_verifyParam',
      ];
      for (const key of globals) {
        try {
          const val = (window as any)[key];
          if (val && typeof val === 'string' && val.length > 10) return val;
        } catch {
          /* ignore */
        }
      }

      // Strategy 2: check if AWSC (Aliyun captcha SDK) has a stored verify param
      try {
        const awsc = (window as any).AWSC;
        if (awsc?.nc?.getVerifyParam) {
          const param = awsc.nc.getVerifyParam();
          if (param) return param;
        }
      } catch {
        /* ignore */
      }

      // Strategy 3: search localStorage for captcha-related keys
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.toLowerCase().includes('captcha')) {
            const v = localStorage.getItem(k);
            if (v && v.length > 10) return v;
          }
        }
      } catch {
        /* ignore */
      }

      // Strategy 4: scan inline script tags for captcha_verify_param assignments
      try {
        const scripts = document.querySelectorAll('script:not([src])');
        for (const s of scripts) {
          const text = s.textContent || '';
          const m1 = text.match(/["']captcha_verify_param["']\s*:\s*["']([^"']{10,})["']/);
          if (m1) return m1[1];
          const m2 = text.match(/captchaVerifyParam\s*[:=]\s*["']([^"']{10,})["']/);
          if (m2) return m2[1];
        }
      } catch {
        /* ignore */
      }

      // Strategy 5: check __NEXT_DATA__ for embedded server-side param
      try {
        const nd = (window as any).__NEXT_DATA__;
        if (nd) {
          const json = JSON.stringify(nd);
          const m = json.match(/captcha_verify_param["']:\s*["']([^"']{10,})["']/);
          if (m) return m[1];
        }
      } catch {
        /* ignore */
      }

      return null;
    });

    if (captchaVerifyParam) {
      logStore.log('info', 'browser', 'Extracted GLM captcha_verify_param from page');
      return { captchaVerifyParam };
    }
  } catch (err: any) {
    logStore.log('warn', 'browser', `Failed to extract GLM captcha fields: ${err.message}`);
  }

  return {};
}
