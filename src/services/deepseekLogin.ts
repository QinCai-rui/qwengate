/*
 * File: deepseekLogin.ts
 * Browser-based auto-login for DeepSeek (no bot challenge).
 */

import { chromium } from 'playwright';
import type { ProviderAuthState } from '../types/auth.ts';
import { logStore } from './logStore.ts';

const DEEPSEEK_LOGIN_URL = 'https://chat.deepseek.com/sign_in';

/**
 * Attempt to auto-login to DeepSeek via Playwright (headless).
 * Falls back to manual if bot challenge is detected.
 */
export async function loginDeepSeek(email: string, password: string): Promise<ProviderAuthState | null> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Navigate directly to DeepSeek sign-in page
    await page.goto(DEEPSEEK_LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for email/password form to appear
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]');
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });

    // Fill credentials
    await emailInput.fill(email);
    await page.waitForTimeout(500);
    const passwordInput = page.locator('input[type="password"]');
    await passwordInput.waitFor({ state: 'visible', timeout: 5000 });
    await passwordInput.fill(password);
    await page.waitForTimeout(500);

    // Submit — try submit button first, then Enter
    const submitBtn = page.locator('button[type="submit"]');
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // Wait for navigation to complete — login redirects to chat
    await page.waitForTimeout(5000);

    // Check if login succeeded — chat page loads with input area
    const chatInput = page.locator('textarea, [contenteditable="true"]');
    const loginSuccess = await chatInput.isVisible({ timeout: 15000 }).catch(() => false);

    if (!loginSuccess) {
      logStore.log('warn', 'deepseek-login', `Auto-login failed for ${email} — bot challenge or form change`);
      await browser.close();
      return null;
    }

    // Capture cookies and local storage as token
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
    logStore.log('error', 'deepseek-login', `DeepSeek login error for ${email}: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

/**
 * Manual browser login for DeepSeek — opens headed browser, auto-fills credentials,
 * user completes any bot challenge and login manually. Browser closes after login detected.
 */
export async function loginDeepSeekManual(email: string, password: string): Promise<ProviderAuthState | null> {
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.goto(DEEPSEEK_LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Auto-fill credentials
    try {
      const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]');
      if (await emailInput.isVisible({ timeout: 8000 }).catch(() => false)) {
        await emailInput.fill(email);
        await page.waitForTimeout(500);
      }
      const passwordInput = page.locator('input[type="password"]');
      if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await passwordInput.fill(password);
        await page.waitForTimeout(500);
      }
    } catch {
      // Form fill failed — user will do it manually
    }

    logStore.log('info', 'deepseek-login', `Browser opened for ${email} at ${DEEPSEEK_LOGIN_URL} — complete login manually`);

    // Wait up to 5 minutes for manual login
    const startTime = Date.now();
    const timeout = 5 * 60 * 1000;
    let loggedIn = false;

    while (Date.now() - startTime < timeout) {
      await page.waitForTimeout(3000);
      try {
        const currentUrl = page.url();
        // DeepSeek dashboard after login redirects away from sign_in
        if (
          currentUrl.includes('/chat') ||
          currentUrl.includes('/dashboard') ||
          currentUrl.includes('/app') ||
          !currentUrl.includes('/sign_in')
        ) {
          loggedIn = true;
          break;
        }
      } catch {
        break; // Page was closed
      }
    }

    if (!loggedIn) {
      logStore.log('warn', 'deepseek-login', `Manual login timed out for ${email}`);
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
    logStore.log('error', 'deepseek-login', `DeepSeek manual login error for ${email}: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}
