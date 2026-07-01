import WebSocket from 'ws';

async function cdpSend(ws, method, params) {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        resolve(msg.result || msg.error);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error('timeout')); }, 15000);
  });
}

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json/version');
  const info = await res.json();
  console.log('Browser:', info.Browser);
  
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));

  // Find existing DeepSeek page or navigate
  const { targetInfos } = await cdpSend(ws, 'Target.getTargets');
  let dsTarget = targetInfos.find(t => t.url && t.url.includes('deepseek') && t.type === 'page');
  let targetId;
  
  if (dsTarget) {
    targetId = dsTarget.targetId;
    console.log('Found existing DeepSeek page:', dsTarget.url);
  } else {
    const { targetId: newId } = await cdpSend(ws, 'Target.createTarget', { url: 'https://chat.deepseek.com/chat' });
    targetId = newId;
    console.log('Created new page, waiting for load...');
    await new Promise(r => setTimeout(r, 8000));
  }

  // Attach to the page
  const pageWs = new WebSocket(info.webSocketDebuggerUrl.replace(/(\/ws\/).*/, '$1') + (await cdpSend(ws, 'Target.attachToTarget', { targetId, flatten: true })).sessionId);
  await new Promise((r) => pageWs.on('open', r));
  
  await cdpSend(pageWs, 'Runtime.enable');
  await cdpSend(pageWs, 'Page.enable');

  // Check current URL
  const urlEval = await cdpSend(pageWs, 'Runtime.evaluate', { expression: 'location.href' });
  console.log('Current URL:', urlEval.result?.value);

  if (urlEval.result?.value?.includes('sign_in')) {
    console.log('ERROR: On login page — session expired');
    ws.close();
    pageWs.close();
    process.exit(1);
  }

  // Extract token
  console.log('\n--- Extracting token ---');
  const tokenEval = await cdpSend(pageWs, 'Runtime.evaluate', {
    expression: `(() => { const raw = localStorage.getItem('userToken'); if (!raw) return JSON.stringify({error:'no token'}); try { const p = JSON.parse(raw); return p.value || p.token || raw; } catch { return raw; } })()`
  });
  const token = tokenEval.result?.value;
  if (!token || token.length < 20) {
    console.log('ERROR: No valid token. Result:', JSON.stringify(tokenEval.result));
    process.exit(1);
  }
  console.log('Token:', token.slice(0, 50) + '...');

  // Test browser chat
  console.log('\n--- Testing chat via browser fetch ---');
  const chatEval = await cdpSend(pageWs, 'Runtime.evaluate', {
    expression: `(async () => {
      const token = ${JSON.stringify(token)};
      const base = 'https://chat.deepseek.com';
      const results = {};
      
      // Step 1: PoW challenge
      const p1 = await fetch(base + '/api/v0/chat/create_pow_challenge', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
        credentials: 'include',
      });
      results.powStatus = p1.status;
      if (!p1.ok) { results.powBody = (await p1.text()).slice(0, 300); return JSON.stringify(results); }
      const powData = await p1.json();
      results.powChallenge = powData.data?.biz_data?.challenge || powData.data;

      // Step 2: Create session
      const p2 = await fetch(base + '/api/v0/chat_session/create', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'include',
      });
      results.sessionStatus = p2.status;
      if (!p2.ok) { results.sessionBody = (await p2.text()).slice(0, 300); return JSON.stringify(results); }
      const sData = await p2.json();
      results.sessionId = sData.data?.biz_data?.chat_session?.id || sData.data?.chat_session?.id || sData.id;

      // Step 3: Send chat
      const p3 = await fetch(base + '/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_session_id: results.sessionId,
          parent_message_id: null,
          prompt: 'User: Say hello in exactly 5 words.',
          ref_file_ids: [], thinking_enabled: false, search_enabled: false, action: null, preempt: false,
        }),
        credentials: 'include',
      });
      results.chatStatus = p3.status;
      if (!p3.ok) { results.chatBody = (await p3.text()).slice(0, 500); return JSON.stringify(results); }
      
      const text = await p3.text();
      results.responseLen = text.length;
      results.responsePreview = text.slice(0, 300);
      
      // Parse content
      let content = '';
      for (const line of text.split('\\n')) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6);
        if (d === '[DONE]') continue;
        try {
          const p = JSON.parse(d);
          if (typeof p.v === 'string') content += p.v;
          else if (p.v?.response?.fragments) {
            for (const f of p.v.response.fragments) if (f.content) content += f.content;
          }
        } catch {}
      }
      results.content = content;
      return JSON.stringify(results);
    })()`,
    awaitPromise: true,
    timeout: 45000,
  });

  console.log('\nChat Result:', chatEval.result?.value);

  // Save token
  const fs = await import('fs');
  fs.writeFileSync('.auth/deepseek-token.txt', token);
  console.log('\nToken saved to .auth/deepseek-token.txt');

  ws.close();
  pageWs.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
