/*
 * File: deepseekLogin.ts
 * Manual browser login for DeepSeek — opens headed browser, auto-fills credentials,
 * user completes any bot challenge manually. Browser closes after login detected.
 */

import type { ProviderAuthState } from '../types/auth.ts';
import { manualBrowserLogin } from './loginHelpers.ts';

const DEEPSEEK_LOGIN_URL = 'https://chat.deepseek.com/sign_in';

export async function loginDeepSeekManual(email: string, password: string): Promise<ProviderAuthState | null> {
  return manualBrowserLogin(email, password, {
    loginUrl: DEEPSEEK_LOGIN_URL,
    provider: 'deepseek',
    authPagePaths: ['/sign_in'],
  });
}
