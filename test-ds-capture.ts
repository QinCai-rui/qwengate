// CDP: capture real DeepSeek requests made by the browser
const CDP = 'http://127.0.0.1:9222';

async function pageWs(targetId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${targetId}`);
  let id = 0;
  const pending = new Map<number, any>();
  await new Promise((r) => ws.onopen = r);
  
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!; pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    // Log network events
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (r.url.includes('/api/v0/')) {
        console.log(`\n>>> ${r.method} ${new URL(r.url).pathname}`);
        const h = r.headers;
        if (h['x-ds-pow-response']) console.log(`  x-ds-pow-response: ${h['x-ds-pow-response'].slice(0,80)}...`);
        console.log(`  cookie: ${(h.cookie||'').slice(0,80)}...`);
        if (r.postData) {
          try { console.log(`  body: ${JSON.stringify(JSON.parse(r.postData)).slice(0,400)}`); }
          catch { console.log(`  body: ${r.postData.slice(0,300)}`); }
        }
      }
    }
    if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/v0/')) {
      const r = m.params.response;
      console.log(`<<< ${r.status} ${new URL(r.url).pathname}`);
    }
  };
  
  return {
    send: (method: string, params?: any): Promise<any> => {
      const msgId = ++id;
      return new Promise((res, rej) => {
        pending.set(msgId, { resolve: res, reject: rej, _method: method });
        ws.send(JSON.stringify({ id: msgId, method, params }));
        setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); rej(new Error(`timeout: ${method}`)); } }, 30000);
      });
    },
    close: () => ws.close()
  };
}

async function main() {
  const info = await (await fetch(`${CDP}/json`)).json();
  console.log('Open pages:');
  info.forEach((p: any) => console.log(`  ${p.id.slice(0,8)}... ${p.url}`));
  
  let dsTarget = info.find((t: any) => t.type === 'page' && t.url?.includes('deepseek'));
  if (!dsTarget) {
    console.log('No DeepSeek page, creating...');
    const bw = new WebSocket(info[0].webSocketDebuggerUrl);
    await new Promise((r) => bw.onopen = r);
    let bid = 0;
    const bsend = (m: string, p?: any): Promise<any> => {
      const mi = ++bid;
      return new Promise((res, rej) => {
        const h = (e: any) => {
          const d = JSON.parse(e.data as string);
          if (d.id === mi) { bw.removeEventListener('message', h); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); }
        };
        bw.addEventListener('message', h);
        bw.send(JSON.stringify({ id: mi, method: m, params: p }));
      });
    };
    const created = await bsend('Target.createTarget', { url: 'https://chat.deepseek.com/chat' });
    dsTarget = { id: created.targetId };
    bw.close();
    console.log('Created, waiting 8s...');
    await new Promise(r => setTimeout(r, 8000));
  }
  
  console.log(`\nUsing: ${dsTarget.id}`);
  const page = await pageWs(dsTarget.id);
  
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Network.enable');
  
  // Check page state
  const urlRes = await page.send('Runtime.evaluate', { expression: 'location.href' });
  console.log(`URL: ${urlRes.result?.value}`);
  
  if (urlRes.result?.value?.includes('sign_in') || urlRes.result?.value?.includes('login')) {
    console.log('ERROR: Login required!');
    page.close();
    process.exit(1);
  }
  
  // Navigate to /chat if not there
  if (!urlRes.result?.value?.endsWith('/chat')) {
    console.log('Navigating to /chat...');
    await page.send('Page.navigate', { url: 'https://chat.deepseek.com/chat' });
    await new Promise(r => setTimeout(r, 6000));
  }
  
  // Extract token
  const tokenRes = await page.send('Runtime.evaluate', {
    expression: `(() => { const r = localStorage.userToken; if(!r) return null; try{const p=JSON.parse(r);return p.value||p.token||r}catch{return r} })()`
  });
  const token = tokenRes.result?.value;
  if (!token || token.length < 20) {
    console.log('ERROR: No token in localStorage');
    page.close();
    process.exit(1);
  }
  console.log(`Token: ${token.slice(0,40)}...`);
  await Bun.write('.auth/deepseek-token.txt', token);
  
  // CAPTURE: Send message via UI to see what the browser sends
  console.log('\n=== CAPTURING REAL BROWSER REQUESTS ===\n');
  
  await page.send('Runtime.evaluate', {
    expression: `
      (() => {
        const ta = document.querySelector('textarea') || document.querySelector('[contenteditable]') || document.querySelector('#chat-input');
        if (!ta) return 'NO TEXTAREA';
        ta.focus();
        if (ta.tagName === 'TEXTAREA') {
          ta.value = 'Say hello in exactly 3 words.';
          ta.dispatchEvent(new Event('input', {bubbles:true}));
        } else {
          ta.textContent = 'Say hello in exactly 3 words.';
          ta.dispatchEvent(new Event('input', {bubbles:true}));
        }
        setTimeout(() => {
          const sendBtn = ta.closest('form')?.querySelector('button[type="submit"]') 
            || document.querySelector('[data-testid="send-button"]')
            || document.querySelector('button svg')?.closest('button');
          if (sendBtn) sendBtn.click();
          else ta.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
        }, 1000);
        return 'message sent';
      })()
    `
  });
  
  console.log('\nWaiting 20s for response...\n');
  await new Promise(r => setTimeout(r, 20000));
  
  // Check response
  const responseRes = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const msgs = document.querySelectorAll('.ds-markdown, [class*="message"] [class*="content"], .markdown');
      const last = Array.from(msgs).slice(-3).map(m => m.textContent?.slice(0, 100) || '');
      return last.join(' | ') || 'no content found';
    })()`
  });
  console.log(`Response: ${responseRes.result?.value}`);
  
  page.close();
  console.log('\n=== Done ===');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
