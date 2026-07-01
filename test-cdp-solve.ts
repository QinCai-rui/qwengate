// Test CDP PoW solver in isolation
const CDP = 'http://127.0.0.1:9222';

async function main() {
  // Get a challenge
  const token = (await Bun.file('.auth/deepseek-token.txt').text()).trim();
  const cRes = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });
  const cBody = await cRes.json();
  const ch = cBody.data?.biz_data?.challenge || cBody.data;
  console.log(`Difficulty: ${ch.difficulty}`);
  
  // Find DeepSeek page in CDP
  const targets = await (await fetch(`${CDP}/json`)).json() as any[];
  const dsTarget = targets.find((t: any) => t.type === 'page' && t.url?.includes('deepseek'));
  if (!dsTarget) { console.log('No DeepSeek page!'); process.exit(1); }
  console.log(`Page: ${dsTarget.url}`);
  
  // Solve via CDP
  console.log('Solving via CDP...');
  const { solvePowViaCdp } = await import('./src/routes/providers/deepseek/pow.ts');
  const answer = await solvePowViaCdp(ch);
  console.log(`Result: ${answer}`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
