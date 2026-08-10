/**
 * GLM Captcha Solver — BROWSERLESS alias for AliyunCaptcha tokens.
 *
 * This module used to launch a persistent Chromium instance and call
 * `initAliyunCaptcha(...).startTracelessVerification()` in the browser to get a
 * `captcha_verify_param`. That worked, but it burned ~40MB of RAM and broke on
 * NixOS where the bundled Chromium is missing shared libraries.
 *
 * The bot-detection solve is now performed entirely in Node by `feilinVmSolver`
 * (it loads the public Aliyun SDK inside `node:vm` and calls InitCaptchaV3 /
 * VerifyCaptchaV3 directly over HTTP — no browser process, zero extra memory).
 *
 * We keep the same exported surface (`getCaptchaVerifyParam`,
 * `invalidateCaptchaToken`, `shutdownCaptchaSolver`) so the pipeline and boot
 * code don't need to change their call sites.
 */

import { logStore } from '../../../services/logStore.ts';
import { resetVmContext } from '../../../services/feilinVmSolver.ts';

const TOKEN_TTL_MS = 45_000;

// ─── Token cache ──────────────────────────────────────────────────────────────

interface CaptchaToken {
  verifyParam: string;
  expiresAt: number;
}

let cachedToken: CaptchaToken | null = null;

/**
 * Returns a fresh `captcha_verify_param` produced by the browserless VM solver.
 * Cached for 45s to avoid solving on every request.
 */
export async function getCaptchaVerifyParam(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.verifyParam;
  }

  const { solveWithVm } = await import('../../../services/feilinVmSolver.ts');
  const verifyParam = await solveWithVm();
  cachedToken = { verifyParam, expiresAt: Date.now() + TOKEN_TTL_MS };
  return verifyParam;
}

/** Force-invalidate the cached token (call after a 403/FRONTEND_CAPTCHA error). */
export function invalidateCaptchaToken(): void {
  cachedToken = null;
  // Drop the VM solver's cached SDK session so the next solve re-inits cleanly.
  try {
    resetVmContext();
  } catch {
    /* best effort */
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * No-op cleanup (kept for the boot/shutdown call site). The VM solver holds no
 * persistent browser process; its context is lazily recreated on next solve.
 */
export async function shutdownCaptchaSolver(): Promise<void> {
  cachedToken = null;
  logStore.log('info', 'glm-captcha', 'Browserless captcha solver idle (no process to shut down)');
}
