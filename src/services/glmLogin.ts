/*
 * File: glmLogin.ts
 * GLM provider login with two strategies:
 * 1. Auto-login (headless stealth) — triggered on dashboard load / startup
 * 2. Manual login (headed browser) — triggered when user clicks Login button
 *
 * GLM uses ES256 JWT tokens from POST /api/v1/auths/signin.
 * The token is returned in the JSON response body (token field), not just cookies.
 */

import type { ProviderAuthState } from '../types/auth.ts';
import { autoLoginViaBrowser } from './browserProfiles.ts';
import { manualBrowserLogin } from './loginHelpers.ts';
import { logStore } from './logStore.ts';

const GLM_LOGIN_URL = 'https://chat.z.ai/auth';
const GLM_BASE_URL = 'https://chat.z.ai';

/** Headless stealth auto-login — tries to log in silently via form fill + persistent profile */
export async function loginGlmAuto(
  email: string,
  password: string,
): Promise<{ status: 'success' | 'captcha' | 'closed' | 'error'; result?: ProviderAuthState }> {
  const outcome = await autoLoginViaBrowser(email, password, {
    provider: 'glm',
    authUrl: GLM_LOGIN_URL,
    authPagePaths: ['/auth'],
    skipFreshLogin: true, // GLM triggers Aliyun captcha on fresh login — only use existing session
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

  if (outcome.status === 'success' && outcome.token) {
    // GLM uses JWT returned from signin API — the cookieStr contains all cookies but
    // the actual JWT is in the `token` cookie value, which autoLoginViaBrowser now extracts

    // Try to extract captcha_verify_param from a fresh browser session
    let captchaVerifyParam: string | undefined = outcome.captchaVerifyParam;
    if (!captchaVerifyParam) {
      try {
        const { setupBrowserContext, extractGlmCaptchaFields } = await import('./browserProfiles.ts');
        const ctx = await setupBrowserContext(email, true);
        const page = ctx.pages()[0] || (await ctx.newPage().catch(() => null));
        if (page) {
          const fields = await extractGlmCaptchaFields(page);
          captchaVerifyParam = fields.captchaVerifyParam;
        }
        await ctx.close().catch(() => {});
      } catch {
        // Non-critical — pipeline works without it
      }
    }

    return {
      status: 'success',
      result: {
        token: outcome.token, // JWT extracted from signin response or token cookie
        expiresAt: outcome.expiresAt,
        refreshToken: null,
        lastLoginAttempt: Date.now(),
        captchaVerifyParam,
        cookies: outcome.cookieStr || undefined,
      },
    };
  }

  // Check if cookie-based fallback works (for cookie-based sessions)
  if (outcome.status === 'success' && outcome.cookieStr) {
    // Extract token from cookie string
    const tokenMatch = outcome.cookieStr.match(/\btoken=([^;]+)/);
    if (tokenMatch) {
      return {
        status: 'success',
        result: {
          token: tokenMatch[1],
          expiresAt: outcome.expiresAt,
          refreshToken: null,
          lastLoginAttempt: Date.now(),
          cookies: outcome.cookieStr || undefined,
        },
      };
    }
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
