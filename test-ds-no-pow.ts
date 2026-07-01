// Test: send chat to DeepSeek WITHOUT PoW header but WITH browser cookies
import { wreqFetch } from './src/services/wreqFetch.ts';

async function main() {
  const token = (await Bun.file('.auth/deepseek-token.txt').text()).trim();
  
  // Read cookies from account (WAF cookies)
  const acctData = await Bun.file('.auth/auth.json').json();
  const dsAcct = acctData.find((a: any) => a.providerStates?.deepseek?.cookies);
  const cookies = dsAcct?.providerStates?.deepseek?.cookies || '';
  
  console.log(`Token: ${token.slice(0,30)}...`);
  console.log(`Cookies: ${cookies.slice(0,80)}...`);
  
  // Step 1: Get challenge (just to know difficulty)
  console.log('\n[1] Get PoW challenge...');
  const cRes = await wreqFetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'cookie': cookies },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    timeout: 15,
    impersonate: 'chrome_142',
  });
  const cBody = await cRes.json();
  console.log(`  Status: ${cRes.status}, upstream: ${cRes.headers.get('X-Upstream-Status')}`);
  
  // Step 2: Create session (no PoW)
  console.log('\n[2] Create session (no PoW)...');
  const sRes = await wreqFetch('https://chat.deepseek.com/api/v0/chat_session/create', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'cookie': cookies, 'accept': 'application/json' },
    body: '{}',
    timeout: 15,
    impersonate: 'chrome_142',
  });
  const sBody = await sRes.json();
  console.log(`  Status: ${sRes.status}`);
  const sessionId = sBody.data?.biz_data?.chat_session?.id || sBody.data?.chat_session?.id || sBody.id;
  console.log(`  Session: ${sessionId}`);
  
  if (!sessionId) { console.log('  FAILED: no session ID'); process.exit(1); }
  
  // Step 3: Send chat WITHOUT PoW header
  console.log('\n[3] Send chat WITHOUT PoW header...');
  const chatRes = await wreqFetch('https://chat.deepseek.com/api/v0/chat/completion', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'cookie': cookies,
      'accept': 'text/event-stream',
    },
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt: 'User: Say hello in 4 words.',
      ref_file_ids: [], thinking_enabled: false, search_enabled: false, action: null, preempt: false,
    }),
    timeout: 30,
    impersonate: 'chrome_142',
    stream: false,
  });
  
  const upstreamStatus = parseInt(chatRes.headers.get('X-Upstream-Status') || '0', 10);
  console.log(`  Status: ${chatRes.status}, upstream: ${upstreamStatus}`);
  
  const text = await chatRes.text();
  console.log(`  Body (first 500): ${text.slice(0, 500)}`);
  
  // Check if response contains valid SSE
  if (text.includes('data: ') && !text.includes('<html')) {
    console.log('\n✅ CHAT WORKS WITHOUT PoW!');
  } else if (text.includes('pow') || text.includes('challenge') || text.includes('bot')) {
    console.log('\n❌ Requires PoW');
  } else if (text.includes('<html') || text.includes('waf')) {
    console.log('\n❌ WAF/HITML response');
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
