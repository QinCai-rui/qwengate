/*
 * File: auth.ts
 * Shared authentication types used across auth.ts, accountManager.ts, and playwright.ts.
 * Extracted to break circular dependency chains.
 */

export interface AuthState {
  token: string;
  expiresAt: number;
  refreshToken: string | null;
}

/** Daily/rolling quota for one model or feature (from /users/user/entitlement_quota) */
export interface EquityQuota {
  times_left: number; // -1 = unlimited
  time_unit: string; // 'day' | 'hour' | ...
  time_amount: number;
}

export interface AccountEntry {
  email: string;
  password: string;
  state: AuthState | null;
  lastUsed: number;
  throttledUntil: number;
  refreshInFlight: Promise<boolean> | null;
  loginAttempt: number;
  inFlight: number;
  totalRequests: number;
  /** Timestamp when inFlight was last incremented — for stuck-request detection */
  lastInFlightAt?: number;
  /** Full cookie string from browser profile (cna, ssxmod_itna, tfstk, isg, token, etc.) for WAF bypass */
  profileCookies?: string;
  /** Startup lifecycle — 'pending' (added), 'initializing' (boot in progress), 'ready' (fully initialized) */
  startupStatus?: 'pending' | 'initializing' | 'connecting' | 'ready';
  /** If true, account is excluded from request routing */
  disabled?: boolean;
  /** Per-model + per-feature daily quota from entitlement_quota endpoint */
  quota?: Record<string, EquityQuota> | null;
  /** Timestamp of last quota fetch */
  quotaFetchedAt?: number;
}
