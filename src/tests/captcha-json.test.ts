/**
 * Final verification: JSON-200 CAPTCHA body via the real HTTP route.
 * Runs in TEST_MOCK_PLAYWRIGHT mode (globalThis.fetch used by transport).
 * stream=true path: before fix → empty SSE, no error. After fix → error status.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = 'test-key-for-testing';
process.env.QWEN_DATA_DIR = '/tmp/qg-testdata';

const { app } = await import('../index.tsx');
const { accounts } = await import('../services/accountManager.ts');

const originalFetch = globalThis.fetch;
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('/chat/completions')) {
    return new Response(JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE', 'captcha required'], data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return originalFetch(input, init);
};

test('stream=true + JSON-200 CAPTCHA → error surfaced, not empty SSE', async () => {
  // Seed inside the test — sibling test files share the accounts module and
  // clear it (accounts.length = 0) between runs.
  accounts.length = 0;
  accounts.push({
    email: 'captcha-test@qwen.dev',
    password: 'pw',
    providerStates: { qwen: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null, lastLoginAttempt: null } },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
  });
  const req = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key-for-testing' },
    body: JSON.stringify({
      model: 'qwen3.7-max',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
  });

  const res = await app.fetch(req);
  const text = await res.text();
  console.log(`status=${res.status}`);
  console.log(`body head: ${text.slice(0, 250)}`);

  // The fix routes JSON-200 through handleErrorResponse → throws →
  // chat.ts retry loop exhausts → 429/5xx with a real error, NOT a 200 SSE stream.
  assert.notStrictEqual(res.status, 200, 'must not be an empty 200 SSE stream');
  assert.ok(text.includes('error') || /FAIL_SYS|CAPTCHA|captcha|rate|limit/i.test(text), 'error must be surfaced');
  console.log('✅ JSON-200 CAPTCHA now produces a real error, not an empty stream');
});
