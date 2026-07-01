/*
 * CDP test: Extract DeepSeek token, test chat via browser fetch, then via our tool.
 */

async function cdp(method: string, params?: any) {
  const target = await fetch('http://127.0.0.1:9222/json/version');
  const info = await target.json();
  const wsUrl = info.webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!.resolve(msg.result || msg.error);
      pending.delete(msg.id);
    }
  };
  
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error('ws error'));
  });
  
  const send = (m: string, p?: any): Promise<any> => {
    const msgId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method: m, params: p }));
      setTimeout(() => {
        if (pending.has(msgId)) {
          pending.get(msgId)!.reject(new Error('timeout'));
          pending.delete(msgId);
        }
      }, 15000);
    });
  };
  
  return { send, ws, info };
}

async function main() {
  console.log('[1] Connecting to Chromium CDP...');
  const { send, ws, info } = await cdp();
  console.log(`  Connected to ${info.Browser}`);
  
  console.log('[2] Navigating to chat.deepseek.com...');
  const pages = (await send('Target.getTargets')).result.targetInfos;
  console.log(`  Found ${pages.length} pages`);
  
  // Find or create a page
  let pageTarget = pages.find((t: any) => t.type === 'page' && t.url.includes('deepseek'));
  if (!pageTarget) {
    const newTarget = await send('Target.createTarget', { url: 'about:blank' });
    pageTarget = { targetId: newTarget.result.targetId };
  }
  
  // Switch to that page
  await send('Target.activateTarget', { targetId: pageTarget.targetId });
  
  // Navigate
  const navResp = await send('Page.navigate', { url: 'https://chat.deepseek.com/chat' });
  console.log(`  Navigate result: ${JSON.stringify(navResp)}`);
  
  // Wait for load
  await send('Page.enable');
  await new Promise(r => setTimeout(r, 5000));
  
  // Check URL
  const urlResp = await send('Runtime.evaluate', { 
    expression: 'JSON.stringify({url: location.href, title: document.title})' 
  });
  console.log(`  Page: ${JSON.stringify(urlResp)}`);
  
  // Extract token
  console.log('[3] Extracting DeepSeek token from localStorage...');
  const tokenResp = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const raw = localStorage.getItem('userToken');
        if (!raw) return JSON.stringify({ error: 'no userToken in localStorage' });
        try {
          const parsed = JSON.parse(raw);
          return parsed.value || parsed.token || raw;
        } catch { return raw; }
      })()
    `
  });
  const token = tokenResp.result?.result?.value;
  console.log(`  Token: ${typeof token === 'string' ? token.slice(0, 40) + '...' : JSON.stringify(tokenResp)}`);
  
  if (!token || typeof token !== 'string' || token.length < 20) {
    console.log('  ERROR: No valid token found');
    ws.close();
    return;
  }
  
  // Save token to file for future reference
  const fs = require('fs');
  fs.writeFileSync('.auth/deepseek-token.txt', token);
  console.log('  Token saved to .auth/deepseek-token.txt');
  
  // Test chat via browser's fetch (this uses browser TLS fingerprint, same as real usage)
  console.log('[4] Testing chat via browser fetch (same-origin, real fingerprint)...');
  const chatResult = await send('Runtime.evaluate', {
    expression: `
      (async () => {
        const token = ${JSON.stringify(token)};
        const base = 'https://chat.deepseek.com';
        
        try {
          // Step A: Get PoW challenge
          const powResp = await fetch(base + '/api/v0/chat/create_pow_challenge', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
            credentials: 'include',
          });
          
          const powStatus = powResp.status;
          const powText = await powResp.clone().text();
          
          if (!powResp.ok) return JSON.stringify({ stage: 'pow_challenge', status: powStatus, body: powText.slice(0, 500) });
          
          const powData = await powResp.json();
          const challenge = powData.data?.biz_data?.challenge || powData.data || powData;
          
          // Step B: Create chat session
          const sessionResp = await fetch(base + '/api/v0/chat_session/create', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body: '{}',
            credentials: 'include',
          });
          
          if (!sessionResp.ok) return JSON.stringify({ stage: 'session_create', status: sessionResp.status, body: (await sessionResp.text()).slice(0, 500) });
          
          const sessionData = await sessionResp.json();
          const sessionId = sessionData.data?.biz_data?.chat_session?.id || sessionData.data?.chat_session?.id || sessionData.id;
          
          // Step C: Send chat message
          const chatResp = await fetch(base + '/api/v0/chat/completion', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
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
            credentials: 'include',
          });
          
          const respHeaders = {};
          chatResp.headers.forEach((v,k) => { respHeaders[k]=v; });
          
          if (!chatResp.ok) return JSON.stringify({ 
            stage: 'chat', 
            status: chatResp.status,
            responseHeaders: respHeaders,
            body: (await chatResp.text()).slice(0, 500),
          });
          
          const text = await chatResp.text();
          const lines = text.split('\\n').filter((l) => l.startsWith('data: '));
          let content = '';
          for (const line of lines) {
            const d = line.slice(6);
            if (d === '[DONE]') continue;
            try {
              const p = JSON.parse(d);
              if (typeof p.v === 'string') content += p.v;
              else if (p.v?.response?.fragments) {
                for (const f of p.v.response.fragments) {
                  if (f.content) content += f.content;
                }
              }
            } catch {}
          }
          
          return JSON.stringify({ stage: 'success', sessionId, content, powChallenge: challenge });
        } catch(e) {
          return JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) });
        }
      })()
    `,
    awaitPromise: true,
    timeout: 30000,
  });
  
  console.log('\n  Chat Result:', chatResult.result?.result?.value);
  
  ws.close();
  console.log('\nDone — browser test complete.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
