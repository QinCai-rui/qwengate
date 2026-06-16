/**
 * Launches a VISIBLE (headed) Chromium browser for chat.qwen.ai
 * and captures all API request payloads for analysis.
 *
 * Usage: bun run scripts/capture-payloads.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const CAPTURE_DIR = join(import.meta.dir, '..', 'network-captures', 'live-capture');
mkdirSync(CAPTURE_DIR, { recursive: true });

const captured: any[] = [];

function saveCapture(name: string, data: any) {
  const path = join(CAPTURE_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`[SAVED] ${path}`);
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome', // Use system Chrome
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: null, // maximize
    locale: 'en-US',
  });

  const page = await context.newPage();

  // Intercept all chat-related API requests
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/v2/chat/completions') || url.includes('/api/v2/chats')) {
      let body: any = null;
      try {
        body = JSON.parse(request.postData() || '{}');
      } catch {}

      const entry = {
        url,
        method: request.method(),
        headers: request.headers(),
        body,
        timestamp: new Date().toISOString(),
      };
      captured.push(entry);
      console.log(`\n[CAPTURED ${captured.length}] ${request.method()} ${url}`);
      if (body) {
        console.log('[PAYLOAD]', JSON.stringify(body, null, 2).substring(0, 2000));
      }
    }
  });

  // Also capture responses
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/v2/chats/new')) {
      try {
        const json = await response.json();
        console.log(`\n[CHATS/NEW RESPONSE]`, JSON.stringify(json, null, 2));
        // Save the chat creation response
        saveCapture('chat-creation-response', json);
      } catch {}
    }
  });

  console.log('\n========================================');
  console.log('  BROWSER OPENED - Log in to chat.qwen.ai');
  console.log('  Then send a multi-turn conversation');
  console.log('  (at least 2-3 back-and-forth messages)');
  console.log('  Press Ctrl+C when done to save captures');
  console.log('========================================\n');

  await page.goto('https://chat.qwen.ai');

  // Wait for user to finish - handle Ctrl+C gracefully
  const shutdown = async () => {
    console.log(`\n\n[DONE] Captured ${captured.length} API requests`);

    // Save all captures
    saveCapture('all-api-requests', captured);

    // Save specific payload types
    const chatCompletions = captured.filter((c) => c.url.includes('/completions'));
    const chatCreations = captured.filter((c) => c.url.includes('/chats/new'));

    if (chatCompletions.length > 0) {
      saveCapture('chat-completions', chatCompletions);
      console.log(`[SUMMARY] ${chatCompletions.length} chat completion requests captured`);
    }
    if (chatCreations.length > 0) {
      saveCapture('chat-creations', chatCreations);
      console.log(`[SUMMARY] ${chatCreations.length} chat creation requests captured`);
    }

    // Print analysis
    if (chatCompletions.length >= 2) {
      console.log('\n[ANALYSIS] Multi-turn payload comparison:');
      for (const [i, req] of chatCompletions.entries()) {
        console.log(`\n--- Request ${i + 1} ---`);
        console.log(`URL: ${req.url}`);
        console.log(`parent_id (top-level): ${req.body?.parent_id}`);
        console.log(`chat_id: ${req.body?.chat_id}`);
        console.log(`model: ${req.body?.model}`);
        console.log(`messages count: ${req.body?.messages?.length}`);
        if (req.body?.messages?.[0]) {
          const msg = req.body.messages[0];
          console.log(`  message[0].role: ${msg.role}`);
          console.log(`  message[0].content: ${String(msg.content).substring(0, 100)}...`);
          console.log(`  message[0].parentId: ${msg.parentId}`);
          console.log(`  message[0].parent_id: ${msg.parent_id}`);
          console.log(`  message[0].childrenIds: ${JSON.stringify(msg.childrenIds)}`);
          console.log(`  message[0].fid: ${msg.fid}`);
          if (msg.feature_config) {
            console.log(`  feature_config: ${JSON.stringify(msg.feature_config)}`);
          }
        }
      }
    }

    await browser.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep browser open until user presses Ctrl+C
  await new Promise(() => {});
}

main().catch(console.error);
