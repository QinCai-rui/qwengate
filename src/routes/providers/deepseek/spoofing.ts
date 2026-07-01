/*
 * File: providers/deepseek/spoofing.ts
 * Browser-like headers and cookies for DeepSeek web chat API.
 * Mimics the exact headers the browser sends to evade bot detection.
 */

import crypto from 'crypto';

export const DEEPSEEK_BASE_URL = 'https://chat.deepseek.com';

export interface DeepSeekHeaders {
  authorization: string;
  'x-client-platform': string;
  'x-app-version': string;
  'x-client-version': string;
  'x-client-bundle-id': string;
  'x-client-locale': string;
  'x-client-timezone-offset': string;
  'x-ds-pow-response'?: string;
  'x-hif-leim'?: string;
  cookie: string;
  'content-type': string;
  accept: string;
  'user-agent': string;
  origin: string;
  referer: string;
  'accept-language': string;
  'accept-encoding': string;
  'sec-fetch-dest': string;
  'sec-fetch-mode': string;
  'sec-fetch-site': string;
  'sec-ch-ua': string;
  'sec-ch-ua-mobile': string;
  'sec-ch-ua-platform': string;
}

export interface DeepSeekContext {
  bearerToken: string;
  deviceId: string;
  smidV2: string;
}

const CHROME_VERSION = '136';
const SEC_CH_UA = `"Not/A)Brand";v="99", "Google Chrome";v="${CHROME_VERSION}", "Chromium";v="${CHROME_VERSION}"`;
const USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

/**
 * Build the full set of browser-like headers for a DeepSeek API call.
 * Optionally include x-ds-pow-response for chat completion requests.
 */
export function buildDeepSeekHeaders(
  ctx: DeepSeekContext,
  opts?: { powResponse?: string; hifLeim?: string; dsSessionId?: string; wafToken?: string },
): DeepSeekHeaders {
  const cookie = buildDeepSeekCookieString(ctx, opts?.dsSessionId, opts?.wafToken);

  const headers: DeepSeekHeaders = {
    authorization: `Bearer ${ctx.bearerToken}`,
    'x-client-platform': 'web',
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    cookie,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': USER_AGENT,
    origin: DEEPSEEK_BASE_URL,
    referer: opts?.dsSessionId ? `${DEEPSEEK_BASE_URL}/a/chat/s/${opts.dsSessionId}` : `${DEEPSEEK_BASE_URL}/`,
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
  };

  if (opts?.powResponse) {
    headers['x-ds-pow-response'] = opts.powResponse;
  }

  if (opts?.hifLeim) {
    headers['x-hif-leim'] = opts.hifLeim;
  }

  return headers;
}

/**
 * Build the cookie string for DeepSeek API calls.
 * Includes: smidV2, ds_session_id (if available), .thumbcache_*, aws-waf-token
 */
export function buildDeepSeekCookieString(ctx: DeepSeekContext, dsSessionId?: string, wafToken?: string): string {
  const parts: string[] = [`smidV2=${ctx.smidV2}`];

  if (dsSessionId) {
    parts.push(`ds_session_id=${dsSessionId}`);
  }

  // Simulate the .thumbcache cookie the browser sets
  const thumbHash = crypto.createHash('md5').update(`thumb_${ctx.deviceId}`).digest('hex');
  const thumbValue = Buffer.from(ctx.deviceId).toString('base64').slice(0, 44);
  parts.push(`.thumbcache_${thumbHash}=${thumbValue}`);

  if (wafToken) {
    parts.push(`aws-waf-token=${wafToken}`);
  }

  return parts.join('; ');
}

/**
 * Generate a realistic DeepSeek context with device fingerprinting values.
 * Uses the bearer token for API calls and generates synthetic but consistent fingerprints.
 */
export function createDeepSeekContext(bearerToken: string, deviceId?: string): DeepSeekContext {
  const id = deviceId || crypto.randomUUID();
  // ponytail: smidV2 is synthetic — DeepSeek uses it for rate limiting correlation
  const smidV2 = crypto.randomUUID();

  return {
    bearerToken,
    deviceId: id,
    smidV2,
  };
}
