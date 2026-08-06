import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { config } from '../services/configService.ts';
import { projectPath } from './paths.ts';

// Compare two strings in timing-constant fashion to prevent timing attacks on API key auth.
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/* ── Dashboard session cookie (issue #45) ──
 *
 * The dashboard HTML pages used to be served with no auth at all, and the
 * raw API key was embedded in every page via `window.API_KEY` — anyone on
 * the network could read the key straight from the page source.
 *
 * Fix: a login page + HttpOnly cookie. Auth is username/password
 * (DASHBOARD_USER / DASHBOARD_PASSWORD, default admin/123456). The cookie
 * holds an HMAC of the password, signed with a per-install secret (never the
 * password itself). When the password changes, all sessions invalidate
 * automatically (the HMAC no longer matches).
 */
const SESSION_COOKIE = 'qg_dash';
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function getSessionSecret(): string {
  const secretFile = projectPath('.qwen', 'dashboard.secret');
  try {
    if (existsSync(secretFile)) {
      return readFileSync(secretFile, 'utf-8').trim();
    }
  } catch {
    // fall through and regenerate
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    const dir = path.dirname(secretFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(secretFile, secret, 'utf-8');
  } catch {
    // Non-persistent secret is still better than nothing (per-process).
  }
  return secret;
}

function sessionMaterial(): string {
  // Bind the session to the configured dashboard password so changing it
  // invalidates every existing session immediately.
  return config.get('DASHBOARD_PASSWORD') || '123456';
}

export function createSessionCookieValue(): string {
  const secret = getSessionSecret();
  const hmac = crypto.createHmac('sha256', secret).update(sessionMaterial()).digest('hex');
  return `v1.${hmac}`;
}

/** Verify a cookie value against the current dashboard password. Returns true when valid. */
export function verifySessionCookieValue(value: string | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  if (!value.startsWith('v1.')) return false;
  const secret = getSessionSecret();
  const hmac = crypto.createHmac('sha256', secret).update(sessionMaterial()).digest('hex');
  return safeCompare(value.slice(3), hmac);
}

/** Read + verify the dashboard session cookie from a request. */
export function hasValidDashboardSession(c: any): boolean {
  const header: string | undefined = c.req.header('cookie');
  if (!header) return false;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name === SESSION_COOKIE && verifySessionCookieValue(decodeURIComponent(value))) {
      return true;
    }
  }
  return false;
}

/** Set-Cookie header for a fresh dashboard session (HttpOnly, SameSite=Strict). */
export function sessionCookieHeader(): string {
  const value = createSessionCookieValue();
  const maxAge = Math.floor(COOKIE_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Expire the dashboard session cookie (logout). */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export const DASHBOARD_SESSION_COOKIE = SESSION_COOKIE;

/**
 * Check API key authorization on a request.
 * Checks Authorization header first, then falls back to ?token= query parameter
 * (for EventSource/SSE and browser page-navigation scenarios).
 * Returns a Response (401) if unauthorized, or undefined if authorized / no key configured.
 */
export function checkApiKeyAuth(c: any): Response | undefined {
  const apiKey = config.get('API_KEY');
  if (!apiKey) return undefined;

  const authHeader = c.req.header('authorization');
  if (authHeader && authHeader.startsWith('Bearer ') && safeCompare(authHeader.slice(7), apiKey)) {
    return undefined;
  }

  const tokenParam = c.req.query('token');
  if (tokenParam && safeCompare(tokenParam, apiKey)) {
    return undefined;
  }

  return c.json({ error: 'Unauthorized' }, 401);
}
