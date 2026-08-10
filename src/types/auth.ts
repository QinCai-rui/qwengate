/*
 * File: auth.ts
 * Shared authentication types used across auth.ts, accountManager.ts, and playwright.ts.
 * Provider-agnostic — each account stores per-provider auth state in providerStates map.
 */

export interface AuthState {
  token: string;
  expiresAt: number;
  refreshToken: string | null;
}

export interface ProviderAuthState {
  token: string | null;
  expiresAt: number | null;
  refreshToken: string | null;
  lastLoginAttempt: number | null;
  /** Browser cookies for this provider (e.g., Qwen WAF bypass cookies) */
  cookies?: string;
  /** Login lifecycle status (e.g., Qwen startup tracking) */
  startupStatus?: 'pending' | 'initializing' | 'connecting' | 'ready';
  /** Last error message from auto-login attempts (e.g., 'captcha: bot detection on auto-login'). Checked by getAuthStatus() for bot/WAF detection. */
  lastError?: string;
  /** GLM captcha verify param (base64 token from Aliyun captcha, required on every chat call) */
  captchaVerifyParam?: string;
  /** DeepSeek AWS WAF token (extracted from document.cookie, required to bypass WAF) */
  wafToken?: string;
}

export interface AccountEntry {
  email: string;
  password: string;
  /** Per-provider auth state — keyed by provider name ('qwen', 'deepseek', 'glm') */
  providerStates: { [provider: string]: ProviderAuthState | undefined };
  /** Which providers this account is configured for (shown in dashboard) */
  providers?: string[];
  lastUsed: number;
  throttledUntil: number;
  refreshInFlight: Promise<boolean> | null;
  loginAttempt: number;
  inFlight: number;
  totalRequests: number;
  /** If true, account is excluded from request routing */
  disabled?: boolean;
  /** Providers specifically disabled for this account (e.g. ['deepseek']) */
  disabledProviders?: string[];
}
