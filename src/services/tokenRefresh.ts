/*
 * File: tokenRefresh.ts
 * Token refresh logic extracted from auth.ts.
 * Handles refresh token exchange and ensuring accounts stay fresh.
 */

import type { AccountEntry } from '../types/auth.ts';
import { getAuthRefreshBeforeMs, getAuthTokenMaxAgeMs, saveCookies } from './auth.ts';
import { loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';
import { performBrowserFetch, refreshViaProfile } from './playwright.ts';

export function needsRefresh(acct: AccountEntry): boolean {
  if (!acct.state) return true;
  return acct.state.expiresAt - getAuthRefreshBeforeMs() < Date.now();
}

const QWEN_CHAT_URL = 'https://chat.qwen.ai';

export async function tryRefreshToken(acct: AccountEntry): Promise<boolean> {
  if (!acct.state?.refreshToken) return false;

  try {
    const result = await performBrowserFetch(acct.email, `${QWEN_CHAT_URL}/api/v2/auths/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refresh_token: acct.state.refreshToken }),
      timeout: 30000,
    });

    if (result.ok) {
      const data = JSON.parse(result.body);
      if (data.data?.token) {
        acct.state = {
          token: data.data.token,
          expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
          refreshToken: data.data.refresh_token || acct.state.refreshToken,
        };
        await saveCookies(acct.email, acct.state.token, acct.state.refreshToken, acct.state.expiresAt);
        if (acct.throttledUntil > Date.now()) {
          acct.throttledUntil = 0;
        }
        return true;
      }
    }

    // If browser fetch fails, fall back to profile-based refresh
    logStore.log('error', 'auth', `HTTP refresh failed for ${acct.email} — falling back to profile-based refresh`);
    try {
      const profileResult = await refreshViaProfile(acct.email);
      if (profileResult) return true;
    } catch (profileErr: any) {
      logStore.log('error', 'auth', `Profile refresh fallback failed for ${acct.email}: ${profileErr.message}`);
    }

    return false;
  } catch (err: any) {
    logStore.log('error', 'auth', 'HTTP fetch failed:', err);
    try {
      const profileResult = await refreshViaProfile(acct.email);
      if (profileResult) {
        logStore.log('error', 'auth', `Token refreshed via profile for ${acct.email} (after network error)`);
        return true;
      }
    } catch (innerErr: any) {
      logStore.log('error', 'auth', `Profile refresh fallback failed: ${innerErr}`);
    }
    return false;
  }
}

export async function ensureAccountFresh(acct: AccountEntry): Promise<boolean> {
  if (acct.state && !needsRefresh(acct)) return true;

  // Avoid concurrent refresh for same account
  if (acct.refreshInFlight) {
    return acct.refreshInFlight;
  }

  acct.refreshInFlight = (async () => {
    try {
      if (acct.state?.refreshToken) {
        if (await tryRefreshToken(acct)) return true;
        logStore.log('warn', 'auth', `Refresh token failed for ${acct.email}`);
      }

      if (acct.throttledUntil > Date.now()) {
        const waitSec = Math.ceil((acct.throttledUntil - Date.now()) / 1000);
        logStore.log('warn', 'auth', `Skipping re-login for ${acct.email} — throttled for ${waitSec}s more`);
        return false;
      }

      const newState = await loginFresh(acct.email, acct.password);
      if (newState) {
        acct.state = newState;
        await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
        return true;
      }
      return false;
    } finally {
      acct.refreshInFlight = null;
    }
  })();

  return acct.refreshInFlight;
}
