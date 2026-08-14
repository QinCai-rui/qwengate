/*
 * File: tokenRefresh.ts
 * Token refresh logic extracted from auth.ts.
 * Handles refresh token exchange and ensuring accounts stay fresh.
 */

import type { AccountEntry } from '../types/auth.ts';
import { getAuthRefreshBeforeMs, getAuthTokenMaxAgeMs, saveCookies } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';

const QWEN_STATE = (acct: AccountEntry) => acct.providerStates.qwen;

export function needsRefresh(acct: AccountEntry): boolean {
  const st = QWEN_STATE(acct);
  if (!st?.token) return true;
  if (!st.expiresAt) return true;
  return st.expiresAt - getAuthRefreshBeforeMs() < Date.now();
}

const QWEN_CHAT_URL = 'https://chat.qwen.ai';

export async function tryRefreshToken(acct: AccountEntry): Promise<boolean> {
  const st = QWEN_STATE(acct);
  if (!st?.refreshToken) return false;

  try {
    const resp = await browserlessFetch(`${QWEN_CHAT_URL}/api/v2/auths/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refresh_token: st.refreshToken }),
    });

    if (!resp.ok) return false;

    const body = await resp.text();
    const data = JSON.parse(body);
    if (!data.data?.token) return false;

    acct.providerStates.qwen = {
      token: data.data.token,
      expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
      refreshToken: data.data.refresh_token || st.refreshToken,
      lastLoginAttempt: null,
    };
    const newState = acct.providerStates.qwen;
    await saveCookies(acct.email, newState.token!, newState.refreshToken, newState.expiresAt ?? undefined);
    if (acct.throttledUntil > Date.now()) {
      acct.throttledUntil = 0;
    }
    return true;
  } catch (err: any) {
    logStore.log('error', 'auth', 'HTTP fetch failed:', err);
    return false;
  }
}

export async function ensureAccountFresh(acct: AccountEntry): Promise<boolean> {
  if (QWEN_STATE(acct) && !needsRefresh(acct)) return true;

  // Avoid concurrent refresh for same account
  if (acct.refreshInFlight) {
    return acct.refreshInFlight;
  }

  acct.refreshInFlight = (async () => {
    try {
      const st = QWEN_STATE(acct);
      if (st?.refreshToken) {
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
        acct.providerStates.qwen = {
          token: newState.token,
          expiresAt: newState.expiresAt,
          refreshToken: newState.refreshToken,
          lastLoginAttempt: null,
        };
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
