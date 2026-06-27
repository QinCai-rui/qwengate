/*
 * File: glmLogin.ts
 * GLM provider login with two strategies:
 * 1. Auto-login (headless stealth) — triggered on dashboard load / startup
 * 2. Manual login (headed browser) — triggered when user clicks Login button
 * The auth page hides the email form behind a "Continue with Email" button.
 */

import type { ProviderAuthState } from '../types/auth.ts';
import { manualBrowserLogin } from './loginHelpers.ts';
import { autoLoginViaBrowser } from './browserProfiles.ts';
import { logStore } from './logStore.ts';

const GLM_LOGIN_URL = 'https://chat.z.ai/auth';

/** Headless stealth auto-login — tries to log in silently via form fill + persistent profile */
export async function loginGlmAuto(
  email: string,
  password: string,
): Promise<{ status: 'success' | 'captcha' | 'closed' | 'error'; result?: ProviderAuthState }> {
  const outcome = await autoLoginViaBrowser(email, password, {
    authUrl: GLM_LOGIN_URL,
    authPagePaths: ['/auth'],
    beforeFill: async (page: any) => {
      // Click "Continue with Email" button to reveal the email/password form
      try {
        const emailBtn = page.locator('span.inline-flex:has-text("Continue")');
        if (await emailBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await emailBtn.click();
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          const fallbackBtn = page.locator('text=Continue with Email');
          if (await fallbackBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await fallbackBtn.click();
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      } catch {
        /* button might not exist */
      }
    },
  });

  if (outcome.status === 'success') {
    return {
      status: 'success',
      result: {
        token: outcome.cookieStr,
        expiresAt: outcome.expiresAt,
        refreshToken: null,
        lastLoginAttempt: Date.now(),
      },
    };
  }

  return { status: outcome.status };
}

/** Headed manual browser login — user completes captcha manually */
export async function loginGlmManual(email: string, password: string): Promise<ProviderAuthState | null> {
  return manualBrowserLogin(email, password, {
    loginUrl: GLM_LOGIN_URL,
    provider: 'glm',
    authPagePaths: ['/auth'],
    beforeFill: async (page, _email, _password) => {
      try {
        const emailBtn = page.locator('span.inline-flex:has-text("Continue")');
        if (await emailBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await emailBtn.click();
          await page.waitForTimeout(2000);
        } else {
          const fallbackBtn = page.locator('text=Continue with Email');
          if (await fallbackBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await fallbackBtn.click();
            await page.waitForTimeout(2000);
          }
        }
      } catch {
        /* button might not exist */
      }
    },
  });
}
