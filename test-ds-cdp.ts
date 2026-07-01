// CDP: Intercept what the REAL browser sends when chatting
// Instead of re-solving PoW, capture the x-ds-pow-response header from the browser
const CDP = 'http://127.0.0.1:9222';

async function main() {
  const targets = await (await fetch(`${CDP}/json`)).json() as any[];
  const dsTarget = targets.find((t: any) => t.type === 'page' && t.url?.includes('deepseek'));
  if (!dsTarget) { console.log('No DeepSeek page'); process.exit(1); }
  
  const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${dsTarget.id}`);
  let id = 0;
  const pending = new Map<number, any>();
  await new Promise((r) => ws.onopen = r);
  
  // Store intercepted PoW headers
  let capturedPowHeader: string | null = null;
  let capturedSessionId: string | null = null;
  
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!; pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    // Intercept requests to capture PoW header
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (r.url.includes('/api/v0/chat/completion')) {
        const h = r.headers || {};
        if (h['x-ds-pow-response']) {
          capturedPowHeader = h['x-ds-pow-response'];
          console.log(`\n🔑 Captured x-ds-pow-response!`);
          console.log(`   ${capturedPowHeader.slice(0, 80)}...`);
          // Decode and show the answer
          try {
            const dec = JSON.parse(atob(capturedPowHeader));
            console.log(`   algorithm: ${dec.algorithm}`);
            console.log(`   answer: ${dec.answer}`);
            console.log(`   difficulty was in challenge`);
          } catch {}
        }
      }
      if (r.url.includes('/api/v0/') && (r.method === 'POST' || r.method === 'GET')) {
        console.log(`>>> ${r.method} ${new URL(r.url).pathname}`);
        if (r.postData) {
          try {
            const pd = JSON.parse(r.postData);
            if (pd.chat_session_id) {
              capturedSessionId = pd.chat_session_id;
              console.log(`   sessionId: ${capturedSessionId}`);
            }
          } catch {}
        }
      }
    }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.url.includes('/api/v0/')) {
        console.log(`<<< ${r.status} ${new URL(r.url).pathname}`);
      }
    }
  };
  
  const send = (method: string, params?: any) => new Promise<any>((res, rej) => {
    const mid = ++id;
    pending.set(mid, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout: ${method}`)); } }, 25000);
  });
  
  await send('Runtime.enable');
  await send('Network.enable');
  
  console.log('[1] Checking page state...');
  const urlRes = await send('Runtime.evaluate', { expression: 'location.href' });
  console.log(`    URL: ${urlRes.result?.value}`);
  
  // Navigate to /chat if needed
  if (!urlRes.result?.value?.endsWith('/chat')) {
    console.log('[2] Navigating to /chat...');
    await send('Page.navigate', { url: 'https://chat.deepseek.com/chat' });
    await new Promise(r => setTimeout(r, 6000));
  }
  
  // Send a message via UI to trigger real PoW solving + chat
  console.log('\n[3] Sending message via UI (triggers real PoW)...\n');
  
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        // Find the textarea — DeepSeek uses textarea in latest UI
        const ta = document.querySelector('textarea');
        if (!ta) return 'NO TEXTAREA FOUND on page';
        
        ta.focus();
        
        // Use native input to trigger React state
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(ta, 'Say hello in 3 words.');
        } else {
          ta.value = 'Say hello in 3 words.';
        }
        
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        
        // Wait a beat for React to react, then click send
        setTimeout(() => {
          // Try various send button selectors
          const sendBtn = document.querySelector('[data-testid="send-button"]')
            || document.querySelector('button[aria-label="Send"]')
            || document.querySelector('button svg path[d*="send"]')?.closest('button')
            || ta.closest('.ds-chat')?.querySelector('button')
            || ta.parentElement?.querySelector('button');
          
          if (sendBtn) {
            console.log('Clicking send button');
            sendBtn.click();
          } else {
            console.log('Pressing Enter');
            ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          }
        }, 1500);
        
        return 'message queued, waiting for send';
      })()
    `
  });
  
  console.log('Waiting 25s for real browser to send chat...\n');
  await new Promise(r => setTimeout(r, 25000));
  
  if (capturedPowHeader) {
    console.log(`\n✅ CAPTURED PoW header (${capturedPowHeader.length} chars)`);
    const headerFile = await import('fs');
    await Bun.write('.auth/deepseek-pow-header.txt', capturedPowHeader);
    
    // Decode it
    const dec = JSON.parse(Buffer.from(capturedPowHeader, 'base64').toString());
    console.log(`   Answer: ${dec.answer}`);
    
    if (capturedSessionId) {
      console.log(`   Session: ${capturedSessionId}`);
    }
  } else {
    console.log('\n❌ NO PoW header captured');
    
    // Check if there's a response
    const resp = await send('Runtime.evaluate', {
      expression: `(() => {
        const msgs = document.querySelectorAll('[class*="message"], .ds-markdown, [class*="content"]');
        const last = Array.from(msgs).slice(-3).map(m => m.textContent?.trim().slice(0, 100) || '').join(' | ');
        return last || 'no content';
      })()`
    });
    console.log(`   Page content: ${resp.result?.value}`);
  }
  
  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
