// Raw test: compare native fetch vs wreqFetch for DeepSeek session create
const token = (await Bun.file('.auth/deepseek-token.txt').text()).trim();
const acctData = await Bun.file('.auth/auth.json').json();
const cookies = acctData.find((a: any) => a.providerStates?.deepseek?.cookies)?.providerStates?.deepseek?.cookies || '';

console.log('[1] Native fetch (TLS fingerprint: Node.js)...');
const nRes = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'cookie': cookies, 'accept': 'application/json' },
  body: '{}',
});
const nText = await nRes.text();
console.log(`  Status: ${nRes.status}`);
console.log(`  Body: ${nText.slice(0, 400)}`);

console.log('\n[2] wreqFetch (TLS fingerprint: Chrome 142)...');
const { wreqFetch } = await import('./src/services/wreqFetch.ts');
const wRes = await wreqFetch('https://chat.deepseek.com/api/v0/chat_session/create', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'cookie': cookies, 'accept': 'application/json' },
  body: '{}',
  timeout: 15,
  impersonate: 'chrome_142',
});
const wText = await wRes.text();
const wUp = wRes.headers.get('X-Upstream-Status');
console.log(`  Status: ${wRes.status}, upstream: ${wUp}`);
console.log(`  Body: ${wText.slice(0, 400)}`);
