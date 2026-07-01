const token = (await Bun.file('.auth/deepseek-token.txt').text()).trim();
const acctData = await Bun.file('.auth/auth.json').json();
const cookies = acctData.find((a: any) => a.providerStates?.deepseek?.cookies)?.providerStates?.deepseek?.cookies || '';

// Step 1: Create session
console.log('[1] Create session...');
const sRes = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'cookie': cookies, 'accept': 'application/json' },
  body: '{}',
});
const sBody = await sRes.json();
const sessionId = sBody.data?.biz_data?.id;
console.log(`  Session ID: ${sessionId}`);

if (!sessionId) { console.log('No session ID'); process.exit(1); }

// Step 2: Try chat WITHOUT PoW header
console.log('\n[2] Chat WITHOUT PoW (native fetch)...');
const chatRes = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'cookie': cookies,
    'accept': 'text/event-stream',
    'origin': 'https://chat.deepseek.com',
    'referer': 'https://chat.deepseek.com/chat',
  },
  body: JSON.stringify({
    chat_session_id: sessionId, parent_message_id: null, prompt: 'User: Hi', ref_file_ids: [],
    thinking_enabled: false, search_enabled: false, action: null, preempt: false,
  }),
});
const text = await chatRes.text();
console.log(`  Status: ${chatRes.status}`);
console.log(`  Content-Type: ${chatRes.headers.get('content-type')}`);
console.log(`  Body (300): ${text.slice(0, 300)}`);

if (text.includes('data: ') && !text.includes('<html')) {
  console.log('\n✅ CHAT SUCCEEDS WITHOUT PoW!');
} else {
  console.log('\n❌ Chat requires PoW. Status:', chatRes.status);
}
