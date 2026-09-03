import crypto from 'node:crypto';
import { safeCompare } from '../utils/auth.ts';
import { config } from './configService.ts';

const COOKIE_NAME = 'qg_dashboard_session';
const MAX_SESSIONS = 1000;
const sessions = new Map<string, number>();

function cookieValue(c: any): string | null {
  const raw = c.req.header('cookie') || '';
  for (const part of raw.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sessionMaxAgeMs(): number {
  return Math.max(5 * 60_000, config.getInt('AUTH_TOKEN_MAX_AGE_MS', 8 * 60 * 60_000));
}

function pruneSessions(now = Date.now()): void {
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
  while (sessions.size > MAX_SESSIONS) {
    const first = sessions.keys().next().value;
    if (!first) break;
    sessions.delete(first);
  }
}

export function dashboardCredentialsConfigured(): boolean {
  return Boolean(config.get('DASHBOARD_USERNAME') && config.get('DASHBOARD_PASSWORD'));
}

export function authenticateDashboard(username: string, password: string): string | null {
  if (!dashboardCredentialsConfigured()) return null;
  if (!safeCompare(username, config.get('DASHBOARD_USERNAME')) || !safeCompare(password, config.get('DASHBOARD_PASSWORD'))) {
    return null;
  }
  pruneSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + sessionMaxAgeMs());
  return token;
}

export function isDashboardAuthenticated(c: any): boolean {
  const token = cookieValue(c);
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroyDashboardSession(c: any): void {
  const token = cookieValue(c);
  if (token) sessions.delete(token);
}

export function setDashboardCookie(c: any, token: string): void {
  const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(sessionMaxAgeMs() / 1000)}`];
  if (secure) flags.push('Secure');
  c.header('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${flags.join('; ')}`);
}

export function clearDashboardCookie(c: any): void {
  c.header('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

export async function requireDashboardAuth(c: any, next: () => Promise<void>): Promise<Response | void> {
  if (!sameOriginForMutation(c)) return c.json({ error: 'Cross-origin request rejected' }, 403);
  if (!isDashboardAuthenticated(c)) {
    if (c.req.method === 'GET' && c.req.path.startsWith('/dashboard')) return c.redirect('/dashboard/login');
    return c.json({ error: 'Dashboard login required' }, 401);
  }
  return next();
}

export async function requireApiOrDashboardAuth(c: any, next: () => Promise<void>): Promise<Response | void> {
  if (isDashboardAuthenticated(c)) {
    if (!sameOriginForMutation(c)) return c.json({ error: 'Cross-origin request rejected' }, 403);
    return next();
  }
  return nextApiKeyOrDeny(c, next);
}

function sameOriginForMutation(c: any): boolean {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return true;
  const origin = c.req.header('origin');
  if (!origin) return true;
  try {
    return origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

async function nextApiKeyOrDeny(c: any, next: () => Promise<void>): Promise<Response | void> {
  const authHeader = c.req.header('authorization');
  const apiKey = config.get('API_KEY');
  if (apiKey && authHeader?.startsWith('Bearer ') && safeCompare(authHeader.slice(7), apiKey)) return next();
  return c.json({ error: apiKey ? 'Unauthorized' : 'Server API_KEY is not configured' }, apiKey ? 401 : 503);
}
