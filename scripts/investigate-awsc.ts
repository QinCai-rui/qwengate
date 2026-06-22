/**
 * INVESTIGATION: Load chat.qwen.ai via Playwright and capture AWSC bootstrap
 *
 * Run: bun run scripts/investigate-awsc.ts
 */

import { chromium, type Page, type Browser, type Request, type Response } from 'playwright';

const TARGET = 'https://chat.qwen.ai/';
const TIMEOUT = 30_000;
const POLL_INTERVAL = 2_000;

// Collectors
const awscUrls: string[] = [];
const awscScriptContents: Map<string, string> = new Map();
const inlineScripts: string[] = [];
const allResources: { url: string; type: string; success: boolean; status?: number }[] = [];

async function main() {
  console.log('=== AWSC Investigation: chat.qwen.ai ===\n');

  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const page: Page = await context.newPage();

  // ---- 1. Request interception ----
  await page.route('**/*', async (route, request) => {
    const url = request.url();
    const resourceType = request.resourceType();
    allResources.push({ url, type: resourceType, success: false });

    // Log all script loads from alicdn
    if (resourceType === 'script' && url.includes('g.alicdn.com')) {
      awscUrls.push(url);
    }

    // Also catch any inline script content via response
    await route.continue();
  });

  // ---- 2. Response interception ----
  page.on('response', async (response: Response) => {
    const url = response.url();
    const status = response.status();

    // Update status in allResources
    const entry = allResources.find((r) => r.url === url);
    if (entry) entry.success = status >= 200 && status < 400;
    if (entry) entry.status = status;

    // Capture AWSC-related script bodies
    if (url.includes('g.alicdn.com') && (url.includes('fireye') || url.includes('baxia') || url.includes('awsc'))) {
      try {
        const buf = await response.body();
        const text = new TextDecoder().decode(buf);
        awscScriptContents.set(url, text);
        console.log(`[CAPTURED] ${url} (${(text.length / 1024).toFixed(1)} KB)`);
      } catch (e) {
        console.log(`[FAILED] Could not read body for ${url}: ${e}`);
      }
    }
  });

  // ---- 3. Capture inline scripts from HTML ----
  page.on('domcontentloaded', async () => {
    try {
      const scripts = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('script:not([src])')).map((s) => s.innerHTML.slice(0, 2000));
      });
      scripts.forEach((s, i) => {
        console.log(`\n--- Inline Script #${i + 1} (${s.length} chars) ---`);
        console.log(s);
        inlineScripts.push(s);
      });
    } catch {
      // page might not be ready
    }
  });

  // ---- 4. Navigate ----
  console.log(`\nNavigating to ${TARGET}...`);
  const startTime = Date.now();
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    console.log(`Page loaded in ${Date.now() - startTime}ms`);
  } catch (e) {
    console.log(`Navigation warning (non-fatal): ${e}`);
  }

  // Wait a bit for scripts to execute
  await page.waitForTimeout(3000);

  // ---- 5. Poll for window.__fyModule ----
  console.log('\nPolling for window.__fyModule...');
  let fyModule: any = null;
  const pollDeadline = Date.now() + TIMEOUT;

  while (Date.now() < pollDeadline) {
    fyModule = await page.evaluate(() => {
      return (window as any).__fyModule ?? null;
    });
    if (fyModule) {
      console.log(`[FOUND] window.__fyModule after ${Date.now() - startTime}ms`);
      break;
    }
    await page.waitForTimeout(POLL_INTERVAL);
  }

  if (!fyModule) {
    console.log('[NOT FOUND] window.__fyModule did not appear within timeout.');
  }

  // ---- 6. Also capture any inline scripts from initial HTML via evaluate ----
  if (fyModule) {
    console.log('\n=== __fyModule BEFORE UBInit ===');
    await dumpModule(page, '__fyModule');
  }

  // ---- 7. Check other AWSC globals BEFORE UBInit ----
  console.log('\n=== AWSC Globals BEFORE UBInit ===');
  await checkAswcGlobals(page);

  // ---- 8. Try UBInit if available ----
  let ubInitExists = false;
  if (fyModule) {
    const hasUBInit = await page.evaluate(() => {
      const m = (window as any).__fyModule;
      return typeof m?.UBInit === 'function';
    });

    if (hasUBInit) {
      ubInitExists = true;
      console.log("\n[INFO] UBInit exists BEFORE we call it — it's part of __fyModule");
      console.log('Calling UBInit({...})...');
      await page.evaluate(() => {
        const m = (window as any).__fyModule;
        m.UBInit({
          AsynSwitch: true,
          SyncSwitch: true,
          interval: 600,
          TraceInterval: 10,
          TraceMax: 300,
          validTime: 3600,
        });
      });
      console.log('UBInit called successfully');
      await page.waitForTimeout(2000);
    } else {
      console.log('\n[INFO] UBInit NOT found on __fyModule before call');
      // Maybe __fyModule only appears after UBInit is called externally?
      // Try calling it via window.__fyModule.UBInit if the module is constructed differently
    }
  } else {
    // Maybe __fyModule only exists AFTER UBInit?
    console.log('\n[INFO] __fyModule was null. Trying to call UBInit via window scope...');
  }

  // ---- 9. Dump __fyModule again AFTER UBInit ----
  console.log('\n=== __fyModule AFTER UBInit ===');
  await dumpModule(page, '__fyModule');

  // ---- 10. Check getFYToken ----
  console.log('\n=== getFYToken ===');
  const tokenResult = await page.evaluate(() => {
    const m = (window as any).__fyModule;
    if (m && typeof m.getFYToken === 'function') {
      try {
        const token = m.getFYToken();
        return { success: true, token, type: typeof token };
      } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
      }
    }
    return { success: false, error: 'getFYToken not found on __fyModule' };
  });
  console.log(JSON.stringify(tokenResult, null, 2));

  // ---- 11. Check fyglobalopt ----
  console.log('\n=== window.fyglobalopt ===');
  const fyglobalopt = await page.evaluate(() => {
    return (window as any).fyglobalopt ?? null;
  });
  console.log(JSON.stringify(fyglobalopt, null, 2));

  // ---- 12. Final global check ----
  console.log('\n=== Final AWSC Globals ===');
  await checkAswcGlobals(page);

  // ---- 13. List all AWSC-related resources ----
  console.log('\n=== AWSC Resource URLs ===');
  awscUrls.forEach((u) => console.log(`  ${u}`));

  console.log('\n=== All Resources ===');
  allResources.forEach((r) => console.log(`  [${r.type}] ${r.status ?? '?'} ${r.success ? 'OK' : 'FAIL'} ${r.url}`));

  // ---- 14. Save captured AWSC scripts ----
  if (awscScriptContents.size > 0) {
    console.log('\n=== Saved AWSC Scripts to disk ===');
    for (const [url, content] of awscScriptContents) {
      const filename = url.split('/').pop() || 'awsc_unknown.js';
      const filepath = `/home/youssefvdel/Projects/qwen-gate/scripts/${filename}`;
      await Bun.write(filepath, content);
      console.log(`  Saved ${url} -> ${filepath} (${(content.length / 1024).toFixed(1)} KB)`);
    }
  }

  await browser.close();
  console.log('\n=== Investigation Complete ===');
}

async function dumpModule(page: Page, globalName: string) {
  const dump = await page.evaluate((name) => {
    const obj = (window as any)[name];
    if (!obj) return { exists: false };

    const result: Record<string, any> = { exists: true };

    // Top-level keys
    const topKeys = new Set<string>();
    try {
      Reflect.ownKeys(obj).forEach((k) => topKeys.add(String(k)));
    } catch {}
    try {
      Object.getOwnPropertyNames(obj).forEach((k) => {
        if (!topKeys.has(k)) topKeys.add(k);
      });
    } catch {}
    try {
      Object.keys(obj).forEach((k) => {
        if (!topKeys.has(k)) topKeys.add(k);
      });
    } catch {}

    result.keys = Array.from(topKeys).sort();

    // Value types and shallow values
    const details: Record<string, any> = {};
    for (const key of topKeys) {
      try {
        const val = (obj as any)[key];
        const t = typeof val;
        if (t === 'function') {
          details[key] = `function(${val.length} params)`;
        } else if (t === 'object' && val !== null) {
          details[key] = `object(${Object.keys(val).length} keys)`;
          // Depth 2
          const sub: Record<string, any> = {};
          for (const k2 of Object.keys(val)) {
            try {
              const v2 = val[k2];
              sub[k2] = typeof v2 === 'function' ? `function(${v2.length} params)` : typeof v2;
            } catch {
              sub[k2] = '<error>';
            }
          }
          details[`${key}__props`] = sub;
        } else {
          details[key] = val;
        }
      } catch {
        details[key] = '<error reading>';
      }
    }
    result.details = details;
    return result;
  }, globalName);

  console.log(JSON.stringify(dump, null, 2));
}

async function checkAswcGlobals(page: Page) {
  const globals = await page.evaluate(() => {
    const w = window as any;
    const candidates = ['__AWSC', 'AWSC', 'baxia', '__baxia', 'fyglobalopt', '__fyModule', 'Alicom', '_Alicom', '__Fireye', 'Fireye'];
    const found: Record<string, any> = {};
    for (const name of candidates) {
      try {
        const val = w[name];
        if (val !== undefined && val !== null) {
          const t = typeof val;
          if (t === 'function') {
            found[name] = `function(${val.length} params)`;
          } else if (t === 'object') {
            const keys = Object.keys(val);
            found[name] = `object(${keys.length} keys): [${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', ...' : ''}]`;
          } else {
            found[name] = val;
          }
        }
      } catch {
        // cross-origin might throw
      }
    }
    return found;
  });

  if (Object.keys(globals).length === 0) {
    console.log('  (none found)');
  } else {
    for (const [k, v] of Object.entries(globals)) {
      console.log(`  ${k}: ${v}`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
