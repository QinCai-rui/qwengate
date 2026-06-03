/*
 * File: browserProfiles.ts
 * Browser profile management extracted from playwright.ts.
 * Handles persistent browser profiles, auto-fill login, and token refresh via profiles.
 */

import { launchPersistentContext as cloakPersistentContext } from 'cloakbrowser';
import path from 'path';
import { mkdirSync } from 'fs';
import type { Cookie } from 'playwright';

export function getProfileDir(email: string): string {
  const safe = email.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  const dir = path.join(process.cwd(), 'qwen_profile', 'chromium-profiles', safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type LoginResult = 'success' | 'captcha' | 'closed' | 'error';

export interface BrowserProfileOptions {
  headless?: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function validateQwenUrl(url: string): void {
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
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
      /^192\.168\.\d+\.\d+$/.test(hostname)) {
    throw new Error(`Blocked private IP URL: ${url}`);
  }
}

export async function openBrowserProfile(email: string, password?: string, options?: BrowserProfileOptions): Promise<LoginResult> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'success' as LoginResult;

  const headless = options?.headless ?? false;
  const profileDir = getProfileDir(email);

  let context: any = null;
  let page: any = null;

  try {
    context = await cloakPersistentContext({
      userDataDir: profileDir,
      headless,
      humanize: true,
      geoip: true,
      viewport: { width: 1920, height: 1080 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1920,1080',
        '--window-position=0,0',
        '--disable-dev-shm-usage',
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

    const existingCookies: Cookie[] = await context.cookies();
    const existingToken = existingCookies.find((c: Cookie) => c.name === 'token');
    if (existingToken && existingToken.expires && existingToken.expires * 1000 > Date.now()) {
      await context.close();
      return 'success';
    }

    page = context.pages()[0] || await context.newPage();

    validateQwenUrl('https://chat.qwen.ai/auth');
    await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (password) {
      try {
        await page.waitForSelector('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]', { timeout: 8000 });
        const emailInput = page.locator('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]').first();
        await emailInput.click();
        await sleep(300 + Math.random() * 400);
        await emailInput.pressSequentially(email, { delay: 50 + Math.random() * 80 });

        await sleep(200 + Math.random() * 300);
        await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 5000 });
        const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
        await passwordInput.click();
        await sleep(200 + Math.random() * 300);
        await passwordInput.pressSequentially(password, { delay: 40 + Math.random() * 60 });

        await sleep(500 + Math.random() * 500);
        try {
          const submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")').first();
          await submitBtn.click({ timeout: 3000 });
        } catch {
          // non-blocking: submit button may not exist on some login pages
        }
      } catch {
        // non-blocking: form fill may fail if selector not found
      }
    }

    const maxAttempts = headless ? 15 : Infinity;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(2000);

      try {
        const cookies: Cookie[] = await context.cookies();
        const tokenCookie = cookies.find((c: Cookie) => c.name === 'token');
        if (tokenCookie) {
          const { saveCookies } = await import('./auth.ts');
          await saveCookies(email, tokenCookie.value);

          try { await context.close(); } catch {
            // non-blocking
          }
          return 'success';
        }

        if (attempt > 0 && attempt % 3 === 0) {
          try {
            const hasCaptcha = await page.evaluate(() => {
              return !!(
                document.querySelector('iframe[src*="recaptcha"]') ||
                document.querySelector('iframe[src*="captcha"]') ||
                document.querySelector('[class*="captcha"]') ||
                document.querySelector('[id*="captcha"]') ||
                document.querySelector('.captcha-container') ||
                document.querySelector('[data-sitekey]') ||
                document.querySelector('.g-recaptcha') ||
                Array.from(document.querySelectorAll('iframe')).some(f =>
                  /challenge|verify|captcha|recaptcha/i.test(f.src || '')
                )
              );
            });
            if (hasCaptcha) {
              if (headless) {
                try { await context.close(); } catch {
                  // intentional: context close failure is non-blocking
                }
                return 'captcha';
              }
            }
          } catch {
            // intentional: captcha detection failure is non-blocking
          }
        }
      } catch {
        try { await context.close(); } catch {
          // intentional: context close failure is non-blocking
        }
        return 'closed';
      }
    }

    console.error('[BrowserProfile] Headless timeout — no login detected, closing browser');
    try { await context.close(); } catch {
      // non-blocking
    }
    return 'error';
  } catch (err: any) {
    console.error('[BrowserProfile] Error:', err.message);
    if (context) { try { await context.close(); } catch {
      // non-blocking
    } }
    return 'error';
  }
}

export async function refreshViaProfile(email: string): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true;

  const profileDir = getProfileDir(email);
  let context: any = null;

  try {
    context = await cloakPersistentContext({
      userDataDir: profileDir,
      headless: true,
      humanize: true,
      geoip: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
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

    const page = context.pages()[0] || await context.newPage();
    validateQwenUrl('https://chat.qwen.ai');
    await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });

    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(1500);
      const cookies: Cookie[] = await context.cookies();
      const tokenCookie = cookies.find((c: Cookie) => c.name === 'token');
      if (tokenCookie && tokenCookie.expires && tokenCookie.expires * 1000 > Date.now()) {
        const { saveCookies } = await import('./auth.ts');
        await saveCookies(email, tokenCookie.value);
        try { await context.close(); } catch {
          // intentional
        }
        return true;
      }
    }

    console.error(`[BrowserProfile] No valid token found after profile navigation for ${email}`);
    try { await context.close(); } catch {
      // intentional
    }
    return false;
  } catch (err: any) {
    console.error(`[BrowserProfile] Profile refresh error for ${email}:`, err.message);
    if (context) { try { await context.close(); } catch {
      // intentional
    } }
    return false;
  }
}

export async function autoFillLogin(email: string, password: string): Promise<boolean> {
  const result = await openBrowserProfile(email, password);
  return result === 'success';
}
