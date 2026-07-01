/*
 * Test DeepSeek end-to-end:
 * 1. Open browser profile → extract token from localStorage
 * 2. Test chat via page.evaluate(fetch) (browser fingerprint)
 * 3. Then test via our tool pipeline
 */

import { chromium } from 'playwright';
import path from 'path';

const PROFILE_DIR = path.resolve('.auth/account-profile/youssefbue_gmail_com');
const DEEPSEEK_BASE = 'https://chat.deepseek.com';

async function main() {
  console.log('[1/4] Launching browser with existing profile...');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = context.pages()[0] || (await context.newPage());

  // Navigate to DeepSeek chat
  console.log('[2/4] Navigating to chat.deepseek.com...');
  await page.goto(DEEPSEEK_BASE + '/chat', { waitUntil: 'networkidle', timeout: 30000 });

  const currentUrl = page.url();
  console.log('  Current URL:', currentUrl);

  if (currentUrl.includes('sign_in') || currentUrl.includes('login')) {
    console.log('  ERROR: Browser is on login page — session expired');
    await context.close();
    return;
  }

  // Extract token from localStorage
  console.log('[3/4] Extracting token from localStorage...');
  const token = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('userToken');
      if (raw) {
        const parsed = JSON.parse(raw);
        return parsed.value || parsed.token || raw;
      }
    } catch {}
    return null;
  });

  if (!token) {
    console.log('  ERROR: No userToken in localStorage');
    await context.close();
    return;
  }

  console.log('  Token:', token.slice(0, 40) + '...');

  // Test via browser's fetch API directly (simulates what our tool does)
  console.log('[4/4] Testing chat via browser fetch...');

  const result = await page.evaluate(
    async (args: { token: string; base: string }) => {
      const { token, base } = args;

      // Step A: Get PoW challenge
      console.log('  A: Getting PoW challenge...');
      const powResp = await fetch(base + '/api/v0/chat/create_pow_challenge', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      });

      if (!powResp.ok) {
        return { stage: 'pow_challenge', error: `HTTP ${powResp.status}: ${await powResp.text()}` };
      }

      const powData = await powResp.json();
      const challenge = powData.data?.biz_data?.challenge || powData.data || powData;
      console.log('  Challenge:', JSON.stringify(challenge).slice(0, 200));

      // Step B: Create chat session
      console.log('  B: Creating chat session...');
      const sessionResp = await fetch(base + '/api/v0/chat_session/create', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      if (!sessionResp.ok) {
        return { stage: 'session_create', error: `HTTP ${sessionResp.status}: ${await sessionResp.text()}` };
      }

      const sessionData = await sessionResp.json();
      const sessionId = sessionData.data?.biz_data?.chat_session?.id || sessionData.data?.chat_session?.id || sessionData.id;
      console.log('  Session ID:', sessionId);

      // Step C: Send a chat message
      console.log('  C: Sending chat message...');
      const chatResp = await fetch(base + '/api/v0/chat/completion', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_session_id: sessionId,
          parent_message_id: null,
          prompt: 'User: Say hello in exactly 5 words.',
          ref_file_ids: [],
          thinking_enabled: false,
          search_enabled: false,
          action: null,
          preempt: false,
        }),
      });

      const respHeaders: Record<string, string> = {};
      chatResp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });

      if (!chatResp.ok) {
        return {
          stage: 'chat',
          error: `HTTP ${chatResp.status}`,
          responseHeaders: respHeaders,
          body: (await chatResp.text()).slice(0, 500),
        };
      }

      const text = await chatResp.text();
      const lines = text.split('\n').filter((l) => l.startsWith('data: '));
      let content = '';
      for (const line of lines) {
        const d = line.slice(6);
        if (d === '[DONE]') continue;
        try {
          const p = JSON.parse(d);
          if (p.v && typeof p.v === 'string') content += p.v;
          else if (p.v?.response?.fragments) {
            for (const f of p.v.response.fragments) {
              if (f.content) content += f.content;
            }
          }
        } catch {}
      }

      return {
        stage: 'success',
        sessionId,
        content,
        responseHeaders: respHeaders,
        textPreview: text.slice(0, 300),
      };
    },
    { token, base: DEEPSEEK_BASE },
  );

  console.log('\n  Result:', JSON.stringify(result, null, 2));

  await context.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
