/*
 * File: zaiLogin.ts
 * Manual browser login for Z.ai (GLM) — always has bot challenge.
 * Opens a headed browser for the user to complete the captcha.
 * The login page hides the email form behind a "Continue with Email" button.
 */

import { chromium } from 'playwright';
import type { ProviderAuthState } from '../types/auth.ts';
import { logStore } from './logStore.ts';

const ZAI_LOGIN_URL = 'https://chat.z.ai/auth';

export async function loginZaiManual(email: string, password: string): Promise<ProviderAuthState | null> {
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.goto(ZAI_LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Click "Continue with Email" button to reveal the email/password form
    // The button has class: inline-flex item-center gap-1 whitespace-nowrap
    try {
      const continueBtn = page.locator('span:has-text("Continue"), span:has-text("with"), span:has-text("Email")').first();
      // Try finding the parent button or the specific span group
      const emailBtn = page.locator('span.inline-flex:has-text("Continue")');
      if (await emailBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await emailBtn.click();
        await page.waitForTimeout(2000);
      } else {
        // Fallback: try any button/span containing "Continue with Email"
        const fallbackBtn = page.locator('text=Continue with Email');
        if (await fallbackBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await fallbackBtn.click();
          await page.waitForTimeout(2000);
        }
      }
    } catch {
      // Button might not exist or already on form — that's fine
    }

    // Try to fill credentials (may not work due to captcha, but worth trying)
    try {
      const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]');
      if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await emailInput.fill(email);
        await page.waitForTimeout(500);
      }
      const passwordInput = page.locator('input[type="password"]');
      if (await passwordInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await passwordInput.fill(password);
        await page.waitForTimeout(500);
      }
    } catch {
      // Form fill failed — user will do it manually
    }

    // Wait for the user to complete login manually (bot check + form)
    logStore.log(
      'info',
      'zai-login',
      `Browser opened for ${email} at ${ZAI_LOGIN_URL} — click "Continue with Email", complete captcha and login`,
    );

    // Wait up to 5 minutes for manual login
    const startTime = Date.now();
    const timeout = 5 * 60 * 1000;
    let loggedIn = false;

    while (Date.now() - startTime < timeout) {
      await page.waitForTimeout(3000);
      try {
        const currentUrl = page.url();
        // Z.ai dashboard URLs after login
        if (
          currentUrl.includes('/chat') ||
          currentUrl.includes('/dashboard') ||
          currentUrl.includes('/app') ||
          !currentUrl.includes('/auth')
        ) {
          loggedIn = true;
          break;
        }
      } catch {
        break; // Page was closed
      }
    }

    if (!loggedIn) {
      logStore.log('warn', 'zai-login', `Manual login timed out for ${email}`);
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
    logStore.log('error', 'zai-login', `Z.ai login error for ${email}: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}
