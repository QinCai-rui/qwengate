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
  return !!(existingToken && existingToken.expires && existingToken.expires * 1000 > Date.now());
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

export type AutoLoginOutcome = { status: 'success'; cookieStr: string; expiresAt: number } | { status: 'captcha' | 'closed' | 'error' };

export async function autoLoginViaBrowser(
  email: string,
  password: string | undefined,
  opts: {
    authUrl: string;
    authPagePaths: string[];
    beforeFill?: (page: any) => Promise<void>;
  },
): Promise<AutoLoginOutcome> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return { status: 'success', cookieStr: '', expiresAt: Date.now() + 3600000 };
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
    const allValid = existingCookies.every((c: any) => !c.expires || c.expires * 1000 > Date.now());
    if (hasAuthCookie && allValid) {
      const cookieStr = existingCookies
        .filter((c: any) => c.value)
        .map((c: any) => `${c.name}=${c.value}`)
        .join('; ');
      const expiresAt =
        existingCookies.reduce((latest: number, c: any) => Math.max(latest, c.expires ? c.expires * 1000 : 0), 0) ||
        Date.now() + 7 * 24 * 60 * 60 * 1000;
      await context.close().catch(() => {});
      logStore.log('info', 'browser', `Existing valid session for ${email} — skipping auto-login`);
      return { status: 'success', cookieStr, expiresAt };
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
          const finalCookies: any[] = await context.cookies();
          await context.close().catch(() => {});
          const cookieStr = finalCookies
            .filter((c: any) => c.value)
            .map((c: any) => `${c.name}=${c.value}`)
            .join('; ');
          const expiresAt =
            finalCookies.reduce((latest: number, c: any) => Math.max(latest, c.expires ? c.expires * 1000 : 0), 0) ||
            Date.now() + 7 * 24 * 60 * 60 * 1000;
          logStore.log('info', 'browser', `✓ Auto-login success for ${email}`);
          return { status: 'success', cookieStr, expiresAt };
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
        await context.close().catch(() => {});
        const cookieStr = currentCookies
          .filter((c: any) => c.value)
          .map((c: any) => `${c.name}=${c.value}`)
          .join('; ');
        const expiresAt =
          currentCookies.reduce((latest: number, c: any) => Math.max(latest, c.expires ? c.expires * 1000 : 0), 0) ||
          Date.now() + 7 * 24 * 60 * 60 * 1000;
        logStore.log('info', 'browser', `✓ Auto-login success (cookie-based) for ${email}`);
        return { status: 'success', cookieStr, expiresAt };
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
