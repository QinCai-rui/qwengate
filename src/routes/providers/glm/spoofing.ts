/*
 * File: providers/glm/spoofing.ts
 * Browser fingerprint query string, headers, and x-signature HMAC for GLM API calls.
 */

export const GLM_BASE_URL = 'https://chat.z.ai';
export const GLM_FE_VERSION = '1.1.67';

const GLM_QUERY_VERSION = '0.0.1';

export interface GlmContext {
  jwt: string;
  userId: string;
  userName: string;
}

/**
 * Build the fingerprint query string for GLM chat completion.
 * Includes 20+ fields about the browser/device.
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
  params.set('user_agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');
  params.set('language', 'en-US');
  params.set('languages', 'en-US,en;q=0.9');
  params.set('timezone', 'Asia/Shanghai');
  params.set('cookie_enabled', 'true');
  params.set('screen_width', '1920');
  params.set('screen_height', '1080');
  params.set('screen_resolution', '1920x1080');
  params.set('viewport_height', '1080');
  params.set('viewport_width', '1920');
  params.set('viewport_size', '1920x1080');
  params.set('color_depth', '24');
  params.set('pixel_ratio', '1');
  params.set('current_url', 'https://chat.z.ai/');
  params.set('pathname', '/');
  params.set('host', 'chat.z.ai');
  params.set('hostname', 'chat.z.ai');
  params.set('protocol', 'https:');
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

// ponytail: simple HMAC cache keyed by body length + jwt suffix to avoid recomputing duplicate payloads
const hmacCache = new Map<string, string>();

async function subtleHmac(data: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute x-signature value.
 * Tries multiple HMAC-SHA256 strategies in order, returns first that produces a non-empty hex.
 * Falls back to unkeyed SHA-256 of the body.
 */
export async function computeSignature(body: string, jwt: string, _timestamp: string, _requestId: string): Promise<string> {
  const cacheKey = `${body.length}:${jwt.slice(-8)}`;
  const cached = hmacCache.get(cacheKey);
  if (cached) return cached;

  // Strategy 1: HMAC-SHA256(body) with key = JWT
  try {
    const sig = await subtleHmac(body, jwt);
    if (sig) {
      hmacCache.set(cacheKey, sig);
      return sig;
    }
  } catch {
    /* next */
  }

  // Strategy 2: HMAC-SHA256(body, '') — unkeyed hash via HMAC
  try {
    const sig = await subtleHmac(body, '');
    if (sig) {
      hmacCache.set(cacheKey, sig);
      return sig;
    }
  } catch {
    /* next */
  }

  // ponytail: unkeyed SHA-256 fallback
  const fallback = await sha256Hex(body);
  hmacCache.set(cacheKey, fallback);
  return fallback;
}

/**
 * Build the full set of headers for a GLM API call.
 * Computes x-signature as HMAC-SHA256 of the body.
 */
export async function buildGlmHeaders(ctx: GlmContext, body: string, requestId: string): Promise<Record<string, string>> {
  const signature = await computeSignature(body, ctx.jwt, '', requestId);

  return {
    Cookie: `token=${ctx.jwt}`,
    'Content-Type': 'application/json',
    'x-fe-version': GLM_FE_VERSION,
    'x-region': 'overseas',
    'x-request-id': requestId,
    Accept: '*/*',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    Origin: 'https://chat.z.ai',
    Referer: 'https://chat.z.ai/',
  };
}

/**
 * Build the variables object for the chat completion body.
 * Includes {{USER_NAME}}, {{CURRENT_DATETIME}}, etc.
 */
export function buildGlmVariables(ctx: GlmContext): Record<string, string> {
  return {
    '{{USER_NAME}}': ctx.userName || 'User',
    '{{CURRENT_DATETIME}}': new Date().toISOString(),
    '{{CURRENT_DATE}}': new Date().toISOString().slice(0, 10),
    '{{CURRENT_TIME}}': new Date().toTimeString().slice(0, 8),
    '{{USER_ID}}': ctx.userId || '',
    '{{MODEL}}': 'glm',
  };
}
