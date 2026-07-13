/*
 * File: providers/glm/captcha-solver.ts
 * Aliyun Captcha V3 solver using CloakBrowser (C++ patched Chromium).
 *
 * Uses CloakBrowser's patched Chromium binary with playwright-core.
 * CloakBrowser patches Chromium at the C++ source level for canvas, WebGL,
 * audio, fonts, and other fingerprint domains — ensuring feilin101.js generates
 * valid fingerprint blobs that pass Aliyun's server-side validation.
 *
 * Loads the AliyunCaptcha.js SDK into a headless page, then calls
 * startTracelessVerification() to obtain a captcha_verify_param.
 * Tokens are cached for 45 seconds. The browser instance is reused across solves.
 */

import { chromium, type Browser } from 'playwright-core';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { logStore } from '../../../services/logStore.ts';

const __dirname = dirname(new URL(import.meta.url).pathname);
const ALIYUN_SDK = readFileSync(resolve(__dirname, 'AliyunCaptcha.js.txt'), 'utf-8');

const TOKEN_TTL_MS = 45_000;
const SOLVE_RETRIES = 3;
const SOLVE_TIMEOUT_MS = 40_000;
const SDK_LOAD_TIMEOUT_MS = 20_000;

const CAPTCHA_CONFIG = {
  region: 'sgp',
  prefix: 'no8xfe',
  sceneId: 'didk33e0',
};

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function findCloakBrowserBinary(): string | null {
  const cloakDir = join(homedir(), '.cloakbrowser');
  if (!existsSync(cloakDir)) return null;
  const dirs = readdirSync(cloakDir).filter((d) => d.startsWith('chromium-'));
  if (dirs.length === 0) return null;
  dirs.sort().reverse();
  const bin = join(cloakDir, dirs[0], 'chrome');
  return existsSync(bin) ? bin : null;
}

interface CaptchaToken {
  verifyParam: string;
  expiresAt: number;
}

let browserPromise: Promise<Browser> | null = null;
let cachedToken: CaptchaToken | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
    } catch {
      // previous launch failed — retry
    }
  }

  const MEMORY_ARGS = [
    '--no-sandbox',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-translate',
    '--disable-sync',
    '--no-first-run',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-features=TranslateUI,IsolateOrigins,site-per-process,BackForwardCache',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--disable-component-update',
    '--disable-ipc-flooding-protection',
    '--disable-breakpad',
    '--disable-logging',
  ];

  const cloakBin = findCloakBrowserBinary();
  if (cloakBin) {
    logStore.debug('glm-captcha', `Using CloakBrowser binary: ${cloakBin}`);
    browserPromise = chromium.launch({
      executablePath: cloakBin,
      headless: true,
      args: MEMORY_ARGS,
    });
  } else {
    logStore.debug('glm-captcha', 'CloakBrowser not found, falling back to Playwright Chromium');
    browserPromise = chromium.launch({
      headless: true,
      args: ['--headless=new', ...MEMORY_ARGS],
    });
  }
  return browserPromise;
}

/** Returns a fresh captcha_verify_param for the GLM API. Cached for 45s. */
export async function getCaptchaVerifyParam(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.verifyParam;
  }

  const verifyParam = await solveWithRetry();
  cachedToken = { verifyParam, expiresAt: Date.now() + TOKEN_TTL_MS };
  return verifyParam;
}

/** Force-invalidate the cached token (call after a 403/FRONTEND_CAPTCHA error). */
export function invalidateCaptchaToken(): void {
  cachedToken = null;
}

async function solveWithRetry(): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= SOLVE_RETRIES; attempt++) {
    try {
      logStore.debug('glm-captcha', `solve attempt ${attempt}/${SOLVE_RETRIES}`);
      return await solveInBrowser();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      logStore.debug('glm-captcha', `attempt ${attempt} failed: ${lastErr.message}`);
    }
  }
  throw new Error(`captcha solve failed after ${SOLVE_RETRIES} attempts: ${lastErr?.message ?? 'unknown'}`);
}

async function solveInBrowser(): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 947 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'Africa/Cairo',
    colorScheme: 'light',
  });

  const page = await context.newPage();

  try {
    const html = buildPageHtml();
    await page.route('https://chat.z.ai/**', (route) => {
      const url = route.request().url();
      if (url === 'https://chat.z.ai/' || url === 'https://chat.z.ai') {
        route.fulfill({ status: 200, contentType: 'text/html', body: html });
      } else {
        route.continue();
      }
    });

    await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.evaluate((cfg) => {
      (window as any).AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };
    }, CAPTCHA_CONFIG);

    await page.waitForFunction(() => typeof (window as any).initAliyunCaptcha === 'function', { timeout: SDK_LOAD_TIMEOUT_MS });

    const param = await page.evaluate(
      async (cfg) => {
        const w = window as any;
        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Captcha solve timeout after ${cfg.timeout}ms`)), cfg.timeout);
          w.initAliyunCaptcha({
            SceneId: cfg.sceneId,
            mode: 'popup',
            region: cfg.region,
            prefix: cfg.prefix,
            language: 'en',
            element: '#captcha-element',
            button: '#captcha-button',
            captchaLogoImg: '',
            showErrorTip: false,
            success: (param: string) => {
              clearTimeout(timeout);
              resolve(param);
            },
            fail: (err: unknown) => {
              clearTimeout(timeout);
              reject(new Error('SDK fail: ' + JSON.stringify(err)));
            },
            getInstance: (inst: any) => {
              inst.startTracelessVerification();
            },
          });
        });
      },
      { ...CAPTCHA_CONFIG, timeout: SOLVE_TIMEOUT_MS },
    );

    logStore.debug('glm-captcha', 'captcha solved successfully');
    return param;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

function buildPageHtml(): string {
  const safeSdk = ALIYUN_SDK.replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html><html><head></head><body>
<div id="captcha-element"></div>
<button id="captcha-button"></button>
<script>${safeSdk}</script>
</body></html>`;
}
