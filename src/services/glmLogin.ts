/*
 * File: glmLogin.ts
 * Manual browser login for GLM — always has bot challenge.
 * Opens a headed browser for the user to complete the captcha.
 * The login page hides the email form behind a "Continue with Email" button.
 */

import type { ProviderAuthState } from '../types/auth.ts';
import { manualBrowserLogin } from './loginHelpers.ts';

const GLM_LOGIN_URL = 'https://chat.z.ai/auth';

export async function loginGlmManual(email: string, password: string): Promise<ProviderAuthState | null> {
  return manualBrowserLogin(email, password, {
    loginUrl: GLM_LOGIN_URL,
    provider: 'glm',
    authPagePaths: ['/auth'],
    beforeFill: async (page, _email, _password) => {
      // Click "Continue with Email" button to reveal the email/password form
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
