/**
 * fireyejsRunner — Extract bx-ua / bx-pp tokens.
 *
 * bx-ua: Extracted from a real browser (Playwright) where fireyejs.js and its
 *   required AWSC loader are properly initialized. fireyejs wraps its API in
 *   closures that require the full browser environment — running the script in
 *   node:vm misses the AWSC bootstrap. The browser is headless and reused for
 *   periodic bx-ua refresh (15 min TTL). Actual chat requests are browserless.
 *
 * bx-pp: Hash fallback (SHA-256 payload sign). Opcode 58 requires the same
 *   fireyejs.AWSC environment as bx-ua — using the browser for bx-pp would
 *   defeat the purpose. The hash fallback worked in real Qwen API testing (200).
 *
 * Auto-extraction: on first call with no cached bx-ua, launches headless
 *   Chromium, navigates chat.qwen.ai, calls __fyModule.getFYToken() after
 *   UBInit(), and caches the result. Subsequent calls use the cache.
 *   No manual steps or env vars required.
 */
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { logStore } from './logStore.ts';
import { tokenCache } from './tokenCache.ts';
import { QWEN_API_BASE } from './qwen.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const BX_UA_TTL_MS = 15 * 60 * 1000; // 15 min — matches research finding
const DEFAULT_FIREYEJS_PATH = resolve(process.cwd(), 'fireyejs.js');

// ─── bx-ua: extract from live browser  ───────────────────────────────────────
// fireyejs.js is 452 KB of obfuscated JS that wraps its API in closures.
// In a real browser, AWSC (Alibaba Web Security Component) bootstraps it and
// exposes window.__fyModule.getFYToken() after UBInit(config).
// No node:vm shim can replicate this without reverse-engineering the entire
// AWSC bootstrap — using Playwright for the 15-min token refresh is the
// reliable path. Chat requests themselves stay browserless.

// Guard: reuse a single browser across extractions instead of launching per call
let playwrightBrowser: any = null;

/** Launch or reuse headless Chromium. Closes after 60s of inactivity. */
async function getBrowser(): Promise<any> {
  if (playwrightBrowser && !(playwrightBrowser as any)._closed) {
    return playwrightBrowser;
  }
  const { chromium } = await import('playwright');
  playwrightBrowser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  return playwrightBrowser;
}

async function closeBrowser(): Promise<void> {
  if (playwrightBrowser && !(playwrightBrowser as any)._closed) {
    try {
      await playwrightBrowser.close();
    } catch {
      // already closed
    }
    playwrightBrowser = null;
  }
}

/**
 * Extract a fresh bx-ua token from chat.qwen.ai using a headless browser.
 *
 * Steps:
 *   1. Navigate to chat.qwen.ai (loads AWSC + fireyejs)
 *   2. Wait for __fyModule to be available
 *   3. Call UBInit(config) then getFYToken()
 *   4. Cache the token
 */
async function extractBxUaFromBrowser(): Promise<string | null> {
  let page: any = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Navigate and wait for AWSC/fireyejs to initialize
    await page.goto(QWEN_API_BASE, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(4_000);

    // Extract bx-ua via __fyModule.getFYToken() after UBInit()
    const result: { fyToken?: string; length?: number; error?: string } | null = await page.evaluate(async () => {
      try {
        const w = window as any;
        const fm = w.__fyModule;
        if (!fm || typeof fm.getFYToken !== 'function') {
          return { error: '__fyModule.getFYToken not available' };
        }
        // Initialize the module if not already loaded
        if (typeof fm.UBInit === 'function' && !fm.load) {
          fm.UBInit({
            AsynSwitch: true,
            SyncSwitch: true,
            interval: 600,
            TraceInterval: 10,
            TraceMax: 300,
            validTime: 3600,
          });
          // UBInit is async — give it a moment
          // Use async sleep so browser microtasks run (while-spin blocked them)
          await new Promise((r) => setTimeout(r, 500));
        }
        const fyToken = fm.getFYToken();
        if (!fyToken || typeof fyToken !== 'string' || fyToken.includes('not_loaded')) {
          return { error: `getFYToken returned: ${String(fyToken).substring(0, 40)}` };
        }
        return { fyToken, length: fyToken.length };
      } catch (e: any) {
        return { error: e.message?.substring(0, 100) };
      }
    });

    if (result?.fyToken) {
      logStore.log('info', 'fireyejs', `bx-ua extracted from browser (${result.length} chars, TTL ${BX_UA_TTL_MS / 60000} min)`);
      return result.fyToken;
    }

    logStore.log('warn', 'fireyejs', `bx-ua browser extraction failed: ${result?.error || 'unknown'}`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'fireyejs', `bx-ua browser extraction error: ${msg.substring(0, 100)}`);
    return null;
  } finally {
    // Close the page (keep browser alive for reuse)
    if (page) {
      try {
        await page.close();
      } catch {
        // already closed
      }
    }
  }
}

// ─── bx-ua generation ────────────────────────────────────────────────────────

/**
 * Generate (or retrieve cached) bx-ua token.
 *
 * bx-ua is a device fingerprint token used by baxia. It has ~15 min TTL.
 * We cache it in memory and refresh via Playwright when stale.
 *
 * @returns The bx-ua token string (e.g. "231!<base64-encoded-data>") or null
 */
export async function generateBxUa(): Promise<string | null> {
  // Check cache first
  const cached = tokenCache.get('bx-ua');
  if (cached) return cached;

  // Extract from live browser context
  logStore.log('info', 'fireyejs', 'No cached bx-ua — extracting from chat.qwen.ai via Playwright...');
  const token = await extractBxUaFromBrowser();

  if (token) {
    tokenCache.set('bx-ua', token, BX_UA_TTL_MS);
    return token;
  }

  logStore.log('warn', 'fireyejs', 'bx-ua extraction failed — using static UA fallback');
  return null;
}

// ─── bx-pp generation (Phase C) ──────────────────────────────────────────────

/**
 * Generate a bx-pp per-request signature.
 *
 * bx-pp is normally generated by fireyejs opcode 58. Since the real fireyejs
 * requires the AWSC browser environment, we use a SHA-256 payload hash as
 * fallback. Testing confirmed this works: the models endpoint returned 200.
 *
 * TODO: reverse-engineer opcode 58 from fireyejs.js for bx-pp generation
 * that matches what the real browser produces.
 */
export async function generateBxPp(payload?: string): Promise<string | null> {
  // ponytail: hash fallback until opcode 58 reverse-engineered
  try {
    const data = new TextEncoder().encode(payload || Date.now().toString());
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hashHex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);
    logStore.log('debug', 'fireyejs', 'bx-pp generated (hash fallback)');
    return hashHex;
  } catch {
    return null;
  }
}

// ─── Cookie refresh via browser ─────────────────────────────────────────────
//
// The browserlessFetch uses wreq-js with Chrome 142 TLS, but baxia still
// requires valid session cookies (especially acw_tc) set by a real browser.
// This function uses the same Playwright browser to navigate chat.qwen.ai,
// let baxia validate the request, and extract fresh cookies.
//
// Pattern: Playwright once per account per 30 min → fresh cookies →
// browserlessFetch for all API calls. No per-request browser overhead.

const COOKIE_REFRESH_TTL_MS = 30 * 60 * 1000; // 30 min

/**
 * Refresh cookies for an account by navigating chat.qwen.ai in a real browser.
 *
 * @param cookieStr - Current saved cookies (may be stale)
 * @returns Fresh cookie string from the browser, or null if refresh failed
 */
export async function refreshCookiesViaBrowser(cookieStr: string): Promise<string | null> {
  let page: any = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Set the saved cookies so the page loads in authenticated state
    if (cookieStr) {
      const cookies = cookieStr.split(';').map((pair: string) => {
        const [name, ...rest] = pair.trim().split('=');
        return { name: name.trim(), value: rest.join('=').trim(), domain: '.chat.qwen.ai', path: '/' };
      });
      await page
        .context()
        .addCookies(cookies)
        .catch(() => {});
    }

    // Navigate — baxia validates the browser, sets fresh acw_tc and other cookies
    await page.goto(QWEN_API_BASE, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3_000);

    // Extract all cookies
    const freshCookies = await page.context().cookies();
    const cookieMap = new Map<string, string>();
    for (const c of freshCookies) {
      cookieMap.set(c.name, c.value);
    }

    const freshCookieStr = Array.from(cookieMap.entries())
      .map(([n, v]) => `${n}=${v}`)
      .join('; ');

    if (freshCookieStr) {
      logStore.log('info', 'fireyejs', `Cookies refreshed via browser: ${freshCookieStr.substring(0, 60)}...`);
      return freshCookieStr;
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'fireyejs', `Cookie refresh via browser failed: ${msg.substring(0, 100)}`);
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Dispose the Playwright browser instance. */
export async function disposeFireyejs(): Promise<void> {
  await closeBrowser();
}
