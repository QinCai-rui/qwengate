/*
 * File: providers/glm/spoofing.ts
 * Browser fingerprint query string, headers for GLM API calls.
 *
 * Headers and fingerprint params match the browser's request exactly.
 */

import { createHmac } from 'node:crypto';

export const GLM_BASE_URL = 'https://chat.z.ai';
export const GLM_FE_VERSION = 'prod-fe-1.1.79';

const GLM_QUERY_VERSION = '0.0.1';

export interface GlmContext {
  jwt: string;
  userId: string;
  userName: string;
}

/**
 * Compute the sorted payload string from URLSearchParams.
 * Sorts params by key and formats as `key=value` comma-separated.
 */
export function computeSortedPayload(params: URLSearchParams): string {
  const entries = Array.from(params.entries());
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

/**
 * Compute x-signature matching the browser's algorithm.
 * HMAC-SHA256 with the following message format:
 *   sortedPayload + "|" + base64(messageContent) + "|" + timestamp
 *
 * The key derivation uses a 5-minute time window when no key is provided.
 */
export function computeSignature(sortedPayload: string, messageContent: string, timestamp: string, hmacKey?: string): string {
  const ts = Number(timestamp);
  const timeBucket = String(Math.floor(ts / 300000)); // 5-minute window

  // base64 encode the message content
  const messageBase64 = Buffer.from(messageContent, 'utf-8').toString('base64');

  // Message to HMAC: sortedPayload|base64(message)|timestamp
  const message = `${sortedPayload}|${messageBase64}|${timestamp}`;

  // Use provided key or derive from time bucket
  const key = hmacKey || timeBucket;

  return createHmac('sha256', key).update(message).digest('hex');
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
  params.set('user_agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
  params.set('language', 'en-US');
  params.set('languages', 'en-US,en');
  params.set('timezone', 'Africa/Cairo');
  params.set('cookie_enabled', 'true');
  params.set('screen_width', '1920');
  params.set('screen_height', '1080');
  params.set('screen_resolution', '1920x1080');
  params.set('viewport_height', '937');
  params.set('viewport_width', '1920');
  params.set('viewport_size', '1920x937');
  params.set('color_depth', '24');
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
  params.set('browser_name', 'Chrome');
  params.set('os_name', 'Linux');
  params.set('signature_timestamp', String(ts));

  return params;
}

/**
 * Build the full set of headers for a GLM API call.
 * Matches the browser's request headers exactly.
 * Computes x-signature from sorted payload + body if not provided.
 */
export function buildGlmHeaders(ctx: GlmContext, body: string, sortedPayload: string, signature?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.jwt}`,
    'content-type': 'application/json',
    'accept-language': 'en-US',
    'x-fe-version': GLM_FE_VERSION,
    referer: '',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
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

  // x-signature: use provided value or compute from sorted payload + body
  if (signature) {
    headers['x-signature'] = signature;
  } else {
    const ts = String(Date.now());
    headers['x-signature'] = computeSignature(sortedPayload, body, ts);
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
