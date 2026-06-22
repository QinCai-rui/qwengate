#!/usr/bin/env bun
/**
 * Auto-extract fireyejs.js from chat.qwen.ai using Playwright.
 *
 * Navigates to chat.qwen.ai, intercepts the fireyejs.js script loaded
 * by baxia (Alibaba anti-bot system), and saves it to disk.
 *
 * Usage:
 *   bun scripts/auto-extract-fireyejs.ts [output_path]
 *
 * Default output path: ./fireyejs.js
 *
 * This script runs headless Chromium via the project's Playwright setup.
 * It does NOT require authentication — fireyejs loads on the initial
 * page before login.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { join, resolve } from 'path';

const OUTPUT_PATH = resolve(process.argv[2] || join(process.cwd(), 'fireyejs.js'));

async function extractFireyejs(): Promise<string> {
  console.log('Launching headless Chromium...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = await browser.newPage();

  // Intercept fireyejs.js requests
  let fireyejsCode: string | null = null;
  let fireyejsUrl: string | null = null;

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('fireyejs') && url.endsWith('.js')) {
      try {
        fireyejsCode = await response.text();
        fireyejsUrl = url;
        console.log(`Intercepted fireyejs.js from: ${url}`);
        console.log(`Size: ${(fireyejsCode.length / 1024).toFixed(1)} KB`);
      } catch (e: any) {
        console.log(`Failed to read fireyejs response: ${e.message}`);
      }
    }
  });

  console.log('Navigating to https://chat.qwen.ai...');
  try {
    await page.goto('https://chat.qwen.ai', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    // Give it a moment for async scripts to load
    await page.waitForTimeout(2000);
  } catch (e: any) {
    // Navigation might timeout waiting for networkidle if the page keeps loading
    // That's fine — we just need the fireyejs script
    console.log(`Navigation note: ${e.message}`);
  }

  await browser.close();

  if (!fireyejsCode) {
    throw new Error('fireyejs.js not found in network traffic. The page may have changed.');
  }

  // Save to disk
  writeFileSync(OUTPUT_PATH, fireyejsCode, 'utf-8');
  console.log(`\nSaved fireyejs.js to: ${OUTPUT_PATH}`);

  return OUTPUT_PATH;
}

// Run
extractFireyejs()
  .then((path) => {
    console.log(`\nExtraction complete. To use:
  FIREYEJS_PATH=${path} BROWSERLESS_FETCH=true bun start`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nExtraction failed: ${err.message}`);
    console.log('\nManual fallback: Open DevTools on chat.qwen.ai → Network → filter "fireyejs" → Save response as fireyejs.js');
    process.exit(1);
  });
