/**
 * captchaDataGen — Pure TypeScript data generator for Aliyun Captcha VerifyCaptchaV3.
 *
 * Ported from izaart95-jpg/GLM-Free-API Python scripts.
 * Generates the `data` field used in CaptchaVerifyParam.
 *
 * Flow:
 *   1. generate_arg(certifyId) — RC4-like scrambling of certifyId
 *   2. Build track JSON with the arg
 *   3. ali_hash(track_json, "0000") — custom hash
 *   4. Concatenate: hash + json_str
 *   5. zlib compress
 *   6. Custom encrypt → base64 = the "data" field
 */

import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';

// ─── RC4-style KSA / PRGA ───────────────────────────────────────────────

/**
 * The 64-element permutation array shared between KSA and PRGA.
 * Derived from the Python script's `r = [...]` array and `n` constant.
 */
function initPermutation(salt: string): number[] {
  const r = [
    32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30, 60, 33, 53, 34, 7, 26, 12, 48, 5, 2, 20, 4, 61, 13, 47, 49, 18, 29, 27,
    22, 1, 17, 39, 56, 41, 38, 55, 31, 15, 58, 52, 40, 8, 57, 45, 35, 59, 36, 42, 54, 63, 3, 24, 28, 14, 9, 0, 21,
  ];

  // KSA (Key Scheduling Algorithm)
  let j = 0;
  const n = salt;
  for (let i = 0; i < r.length; i++) {
    j = (((i + j + r[i] + r[j]) >> 1) + n.charCodeAt(i % n.length)) & (r.length - 1);
    if (i !== j) {
      r[i] ^= r[j];
      r[j] ^= r[i];
      r[i] ^= r[j];
    }
  }
  return r;
}

/**
 * RC4-style PRGA on the input text using the permutation array.
 */
function rc4Crypt(text: string, r: number[]): string {
  let result = '';
  let e = 0;
  let a = 0;

  for (let idx = 0; idx < text.length; idx++) {
    a = ((e ^ a) + (r[e] ^ r[a])) & (r.length - 1);
    if (e !== a) {
      r[e] ^= r[a];
      r[a] ^= r[e];
      r[e] ^= r[a];
    }
    let m = text.charCodeAt(idx);
    m = m + e + r[e] - a - r[a];
    m = m ^ (r[e] + r[a]);
    m = m ^ r[(r[e] + r[a]) & (r.length - 1)];
    m = m & 255;
    result += String.fromCharCode(m);
    e = (e + 1) & (r.length - 1);
  }
  return result;
}

// ─── generate_arg(certifyId) ─────────────────────────────────────────────

/**
 * Generates the "arg" field from a certifyId.
 * Uses URL-decoding + RC4-like transform with the constant "4xrihv8zb8tf1mfj".
 */
export function generateArg(certifyId: string): string {
  const encoded = encodeURIComponent(certifyId);
  // URL-decode (decode %XX sequences)
  let o = '';
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%' && i + 2 < encoded.length) {
      o += String.fromCharCode(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      o += encoded[i];
    }
  }

  const constant = '4xrihv8zb8tf1mfj';
  const r = initPermutation(constant);
  const encrypted = rc4Crypt(o, r);
  return Buffer.from(encrypted, 'latin1').toString('base64');
}

// ─── Track JSON builder ─────────────────────────────────────────────────

/**
 * Builds the track JSON object used in VerifyCaptchaV3 data.
 */
function buildTrackJson(certifyId: string, arg: string): object {
  const now = Date.now();
  return {
    TrackList: {
      mc: '',
      tc: '',
      mu: '',
      te: '',
      mp: '',
      tmv: '',
      ks: '',
      fi: '',
      startTime: now,
    },
    TrackStartTime: now,
    VerifyTime: now + 300,
    arg: arg,
  };
}

// ─── ali_hash(input, salt) ──────────────────────────────────────────────

/**
 * Custom hash function from the AliyunCaptcha SDK.
 * 16-iteration permutation + diffusion.
 */
export function aliHash(input: string, salt: string): string {
  const o = Buffer.from(input, 'utf-8');
  const n = salt;
  const m = n.length;

  // Initialize 16-element permutation
  const e: number[] = [];
  for (let i = 0; i < 16; i++) {
    e.push((i << 4) + (i % 16));
  }

  // KSA
  let j = 0;
  for (let i = 0; i < e.length; i++) {
    j = (((i + j + e[i] + e[j]) >> 1) + n.charCodeAt(i % m)) & (e.length - 1);
    const tmp = e[i];
    e[i] = e[j];
    e[j] = tmp;
  }

  // PRGA
  let p = 0;
  let q = 0;
  for (let idx = 0; idx < o.length; idx++) {
    q = ((p ^ q) + (e[p] ^ e[q])) & (e.length - 1);
    const tmp = e[p];
    e[p] = e[q];
    e[q] = tmp;
    let C = o[idx];
    C = (C + p + q) ^ e[p] ^ e[q];
    C = C & 255;
    e[p] = C;
    p = (p + 1) & (e.length - 1);
  }

  // Diffusion pass
  for (let step = 0; step < 2 * e.length; step++) {
    const pos = step % e.length;
    if (pos !== 0) {
      e[pos] ^= e[pos - 1];
    } else {
      e[0] ^= e[e.length - 1];
    }
  }

  return e.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

// ─── Custom encrypt (same as Python script) ─────────────────────────────

function customEncrypt(plaintext: Buffer): string {
  // Convert to latin-1 string (ISO-8859-1)
  const o = Buffer.from(plaintext).toString('latin1');
  const salt = '3e627e1b4c63f913';
  const r = initPermutation(salt);
  const encrypted = rc4Crypt(o, r);
  return Buffer.from(encrypted, 'latin1').toString('base64');
}

// ─── Main data generator ─────────────────────────────────────────────────

/**
 * Generate the full `data` field value for VerifyCaptchaV3.
 *
 * @param certifyId - The CertifyId from InitCaptchaV3
 * @returns Base64 string of the encrypted data payload
 */
export function generateCaptchaData(certifyId: string): string {
  // 1. Generate arg from certifyId
  const arg = generateArg(certifyId);

  // 2. Build track JSON
  const track = buildTrackJson(certifyId, arg);
  const jsonStr = JSON.stringify(track);

  // 3. Hash
  const hash = aliHash(jsonStr, '0000');

  // 4. Combine hash + json
  const combined = hash + jsonStr;

  // 5. zlib compress
  const compressed = deflateSync(Buffer.from(combined, 'utf-8'));

  // 6. Encrypt the compressed + base64
  const compressedB64 = compressed.toString('base64');
  const finalData = customEncrypt(Buffer.from(compressedB64, 'utf-8'));

  return finalData;
}

// ─── ─────────────────────────────────────────────────────────────────────
