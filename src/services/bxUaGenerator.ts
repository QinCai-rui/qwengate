/**
 * bxUaGenerator — Pure Node.js bx-ua token generation.
 *
 * Goal: replace Playwright-based bx-ua extraction with a pure Node.js
 * implementation that replicates the fireyejs.js fingerprint algorithm.
 *
 * Current: Playwright launches headless Chromium → navigates chat.qwen.ai
 * → calls window.__fyModule.getFYToken() → 1200-char token.
 *
 * Target: Collect all fingerprint signals that fireyejs reads, apply the
 * same encoding/encryption, produce the same 231!<base64> token format.
 *
 * Status: UNDER CONSTRUCTION — this is the scaffold for the fingerprint
 * collector. The encoding/encryption algorithm needs reverse-engineering
 * from fireyejs.js.
 */
import { randomUUID } from 'crypto';
import { logStore } from './logStore.ts';
import { tokenCache } from './tokenCache.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const BX_UA_TTL_MS = 15 * 60 * 1000; // 15 minutes
const BX_UA_VERSION = '231';

// ─── Fingerprint signals ─────────────────────────────────────────────────────
// These are the signals fireyejs collects to build a device fingerprint.
// The real fireyejs reads these from the browser DOM APIs.
// We'll provide realistic simulated values that match a Chrome/Linux profile.

export interface FingerprintSignals {
  // Navigator
  userAgent: string;
  platform: string;
  language: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number | undefined;
  maxTouchPoints: number;
  plugins: string[];
  // Screen
  screenWidth: number;
  screenHeight: number;
  screenAvailWidth: number;
  screenAvailHeight: number;
  screenColorDepth: number;
  screenPixelDepth: number;
  // Timezone
  timezone: string;
  timezoneOffset: number;
  // Canvas (pre-recorded from real browser)
  canvasFingerprint: string;
  // WebGL (pre-recorded from real browser)
  webglVendor: string;
  webglRenderer: string;
  webglFingerprint: string;
  // Audio
  audioFingerprint: string;
  // Fonts
  fonts: string[];
  // Performance
  timeOrigin: number;
  // Battery
  batteryCharging: boolean | null;
  batteryLevel: number | null;
  // Additional
  doNotTrack: string | null;
  cookieEnabled: boolean;
  productSub: string;
  vendor: string;
  vendorSub: string;
  product: string;
  appCodeName: string;
  appName: string;
  appVersion: string;
  oscpu: string | undefined;
  buildID: string | undefined;
}

/** Default Chrome/Linux fingerprints. Replace with real values from your env. */
export function getDefaultFingerprint(): FingerprintSignals {
  return {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    language: 'en-US',
    languages: ['en-US', 'en'],
    hardwareConcurrency: 16,
    deviceMemory: undefined, // not available on Linux
    maxTouchPoints: 0,
    plugins: [],
    screenWidth: 1920,
    screenHeight: 1080,
    screenAvailWidth: 1920,
    screenAvailHeight: 1040,
    screenColorDepth: 24,
    screenPixelDepth: 24,
    timezone: 'Asia/Shanghai',
    timezoneOffset: -480, // UTC+8
    canvasFingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    webglVendor: 'Google Inc. (AMD)',
    webglRenderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001538) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webglFingerprint: 'a1b2c3d4e5f6...',
    audioFingerprint: 'default_audio_fingerprint',
    fonts: ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana'],
    timeOrigin: Date.now(),
    batteryCharging: null,
    batteryLevel: null,
    doNotTrack: null,
    cookieEnabled: true,
    productSub: '20030107',
    vendor: 'Google Inc.',
    vendorSub: '',
    product: 'Gecko',
    appCodeName: 'Mozilla',
    appName: 'Netscape',
    appVersion: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    oscpu: undefined,
    buildID: undefined,
  };
}

// ─── Signal mappers ──────────────────────────────────────────────────────────
// Maps real browser APIs to our signals. Used when we have access to a real
// browser (Playwright) to capture accurate values once, then reuse them.

export function signalsFromBrowser(evaluate: (fn: () => any) => Promise<any>): Promise<Partial<FingerprintSignals>> {
  return evaluate(() => {
    const w = window as any;
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: navigator.languages,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as any).deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      plugins: Array.from(navigator.plugins).map((p: any) => p.name),
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenAvailWidth: screen.availWidth,
      screenAvailHeight: screen.availHeight,
      screenColorDepth: screen.colorDepth,
      screenPixelDepth: screen.pixelDepth,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),
      productSub: navigator.productSub,
      vendor: navigator.vendor,
      vendorSub: navigator.vendorSub,
      product: navigator.product,
      appCodeName: navigator.appCodeName,
      appName: navigator.appName,
      appVersion: navigator.appVersion,
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: (navigator as any).doNotTrack,
    };
  });
}

// ─── Token assembly ──────────────────────────────────────────────────────────
// TODO: Reverse-engineer the encoding/encryption from fireyejs.js
// The raw fingerprint data is processed through fireyejs's algorithm to produce
// the final 231!<base64> token. This section will be filled in as we
// reverse-engineer the algorithm.

/** Build a stable key from fingerprints for caching. */
function fingerprintKey(f: FingerprintSignals): string {
  const parts = [
    f.userAgent,
    f.platform,
    f.timezone,
    f.screenWidth,
    f.screenHeight,
    f.canvasFingerprint.substring(0, 16),
    f.webglFingerprint.substring(0, 16),
  ];
  return parts.join('|');
}

/**
 * Encode fingerprint signals into bx-ua token format.
 *
 * TODO: This is a STUB — needs the real fireyejs encoding algorithm.
 * The real algorithm:
 *   1. Collects all signals into a structured object
 *   2. Serializes with specific field ordering
 *   3. Applies custom encryption/encoding
 *   4. Prepends BX_UA_VERSION + '!'
 *   5. Caches and returns
 */
function encodeFingerprint(signals: FingerprintSignals): string {
  // ponytail: placeholder encoding — replace with reverse-engineered algorithm
  const payload = {
    v: BX_UA_VERSION,
    ua: signals.userAgent,
    tz: signals.timezone,
    scr: `${signals.screenWidth}x${signals.screenHeight}`,
    c: signals.canvasFingerprint.substring(0, 32),
    w: signals.webglFingerprint.substring(0, 32),
    ts: Date.now(),
    nonce: randomUUID().replace(/-/g, '').substring(0, 16),
  };
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json).toString('base64');
  return `${BX_UA_VERSION}!${base64}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a bx-ua token from fingerprint signals.
 *
 * Uses cached token if valid, otherwise generates a fresh one.
 *
 * @param signals - Optional fingerprint signals (uses defaults if not provided)
 * @returns bx-ua token string (e.g. "231!<base64>")
 */
export async function generateBxUa(signals?: FingerprintSignals): Promise<string | null> {
  // Check cache first
  const cached = tokenCache.get('bx-ua');
  if (cached) return cached;

  const fp = signals || getDefaultFingerprint();
  const token = encodeFingerprint(fp);

  if (token) {
    tokenCache.set('bx-ua', token, BX_UA_TTL_MS);
    logStore.log('info', 'bxua', `bx-ua generated (${token.length} chars, TTL ${BX_UA_TTL_MS / 60000} min)`);
  }

  return token;
}

/**
 * Capture real fingerprint signals from Playwright, encode as bx-ua,
 * and return both the signals and the token.
 */
export async function captureAndGenerate(
  browserPageEvaluate: (fn: () => any) => Promise<any>,
): Promise<{ signals: Partial<FingerprintSignals>; token: string }> {
  const signals = await signalsFromBrowser(browserPageEvaluate);
  const fp = { ...getDefaultFingerprint(), ...signals };
  const token = encodeFingerprint(fp);
  return { signals, token };
}

export { BX_UA_TTL_MS, BX_UA_VERSION };
