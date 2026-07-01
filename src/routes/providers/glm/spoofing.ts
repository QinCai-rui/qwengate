/*
 * File: providers/glm/spoofing.ts
 * Browser fingerprint query string, headers for GLM API calls.
 *
 * Headers and fingerprint params match the browser's request exactly.
 */

import { createHmac } from 'node:crypto';

export const GLM_BASE_URL = 'https://chat.z.ai';
export const GLM_FE_VERSION = 'prod-fe-1.1.69';

const GLM_QUERY_VERSION = '0.0.1';

export interface GlmContext {
  jwt: string;
  userId: string;
  userName: string;
}

/**
 * Compute x-signature from sorted URL param key=value pairs.
 * HMAC-SHA256 with empty key (browser's key is unknown — this is best effort).
 */
export function computeSignature(requestId: string, timestamp: string, userId: string, _jwt: string): string {
  const params = { requestId, timestamp, user_id: userId };
  const sorted = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');

  // ponytail: empty HMAC key — real key is in browser's minified JS bundle
  return createHmac('sha256', '').update(sorted).digest('hex');
}

/**
 * Build the fingerprint query string for GLM chat completion.
 * Matches browser's URL query params exactly.
 */
export function buildFingerprintParams(ctx: GlmContext): URLSearchParams {
  const ts = Date.now();
  const params = new URLSearchParams();
  const uuid = crypto.randomUUID();

  params.set('timestamp', String(ts));
  params.set('requestId', uuid);
  params.set('user_id', ctx.userId || '');
  params.set('version', GLM_QUERY_VERSION);
  params.set('platform', 'web');
  params.set('token', ctx.jwt);
  params.set('user_agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36');
  params.set('language', 'en-US');
  params.set('languages', 'en-US,en');
  params.set('timezone', 'Africa/Cairo');
  params.set('cookie_enabled', 'true');
  params.set('screen_width', '1920');
  params.set('screen_height', '1080');
  params.set('screen_resolution', '1920x1080');
  params.set('viewport_height', '947');
  params.set('viewport_width', '1920');
  params.set('viewport_size', '1920x1080');
  params.set('color_depth', '30');
  params.set('pixel_ratio', '1');
  params.set('current_url', 'https://chat.z.ai/');
  params.set('pathname', '/');
  params.set('host', 'chat.z.ai');
  params.set('hostname', 'chat.z.ai');
  params.set('protocol', 'https:');
  params.set('search', '');
  params.set('hash', '');
  params.set('referrer', '');
  params.set('title', '');
  params.set('timezone_offset', String(-new Date().getTimezoneOffset()));
  params.set('local_time', new Date().toLocaleString());
  params.set('utc_time', new Date().toISOString());
  params.set('is_mobile', 'false');
  params.set('is_touch', 'false');
  params.set('max_touch_points', '0');
  params.set('browser_name', 'chrome');
  params.set('os_name', 'linux');
  params.set('signature_timestamp', String(ts));

  return params;
}

/**
 * Build the full set of headers for a GLM API call.
 * Matches the browser's request headers exactly.
 * Computes x-signature from URL params if not provided.
 */
export function buildGlmHeaders(ctx: GlmContext, body: string, requestId: string, signature?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.jwt}`,
    'content-type': 'application/json',
    'accept-language': 'en-US',
    'x-fe-version': GLM_FE_VERSION,
    referer: '',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'x-region': 'overseas',
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    connection: 'keep-alive',
    host: 'chat.z.ai',
    origin: 'https://chat.z.ai',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-gpc': '1',
  };

  // x-signature: use provided value or compute best-effort
  if (signature) {
    headers['x-signature'] = signature;
  } else {
    const ts = String(Date.now());
    headers['x-signature'] = computeSignature(requestId, ts, ctx.userId, ctx.jwt);
  }

  return headers;
}

/**
 * Build the variables object for the chat completion body.
 * Includes {{USER_NAME}}, {{CURRENT_DATETIME}}, etc.
 */
export function buildGlmVariables(ctx: GlmContext): Record<string, string> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());

  return {
    '{{USER_NAME}}': ctx.userName || 'User',
    '{{USER_LOCATION}}': 'Unknown',
    '{{CURRENT_DATETIME}}': `${y}-${mo}-${d} ${h}:${mi}:${s}`,
    '{{CURRENT_DATE}}': `${y}-${mo}-${d}`,
    '{{CURRENT_TIME}}': `${h}:${mi}:${s}`,
    '{{CURRENT_WEEKDAY}}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()],
    '{{CURRENT_TIMEZONE}}': Intl.DateTimeFormat().resolvedOptions().timeZone,
    '{{USER_LANGUAGE}}': 'en-US',
  };
}
