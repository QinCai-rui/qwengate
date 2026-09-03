import crypto from 'crypto';
import { config } from '../services/configService.ts';

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

/**
 * Check API key authorization on a request.
 * Checks the Authorization header. Query-string credentials are intentionally not
 * accepted because URLs are routinely copied into logs, browser history, and
 * referrer headers.
 * Returns a Response if unauthorized or misconfigured, or undefined if authorized.
 */
export function checkApiKeyAuth(c: any): Response | undefined {
  const apiKey = config.get('API_KEY');
  if (!apiKey) return c.json({ error: 'Server API_KEY is not configured' }, 503);

  const authHeader = c.req.header('authorization');
  if (authHeader && authHeader.startsWith('Bearer ') && safeCompare(authHeader.slice(7), apiKey)) {
    return undefined;
  }

  return c.json({ error: 'Unauthorized' }, 401);
}

export function requireApiKey(c: any, next: () => Promise<void>): Response | Promise<void> {
  const denied = checkApiKeyAuth(c);
  if (denied) return denied;
  return next();
}
