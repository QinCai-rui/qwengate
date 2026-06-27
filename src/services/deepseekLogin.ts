/*
 * File: deepseekLogin.ts
 * DeepSeek provider login with two strategies:
 * 1. Auto-login (headless stealth) — triggered on dashboard load / startup
 * 2. Manual login (headed browser) — triggered when user clicks Login button
 */

import type { ProviderAuthState } from '../types/auth.ts';
import { manualBrowserLogin } from './loginHelpers.ts';
import { autoLoginViaBrowser } from './browserProfiles.ts';
import { logStore } from './logStore.ts';

const DEEPSEEK_LOGIN_URL = 'https://chat.deepseek.com/sign_in';

/** Headless stealth auto-login — tries to log in silently via form fill + persistent profile */
export async function loginDeepseekAuto(
  email: string,
  password: string,
): Promise<{ status: 'success' | 'captcha' | 'closed' | 'error'; result?: ProviderAuthState }> {
  const outcome = await autoLoginViaBrowser(email, password, {
    authUrl: DEEPSEEK_LOGIN_URL,
    authPagePaths: ['/sign_in'],
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
export async function loginDeepSeekManual(email: string, password: string): Promise<ProviderAuthState | null> {
  return manualBrowserLogin(email, password, {
    loginUrl: DEEPSEEK_LOGIN_URL,
    provider: 'deepseek',
    authPagePaths: ['/sign_in'],
  });
}
