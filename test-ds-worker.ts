// CDP: Use DeepSeek's own API client on the page (already handles PoW)
const CDP = 'http://127.0.0.1:9222';

async function main() {
  const targets = await (await fetch(`${CDP}/json`)).json() as any[];
  const dsTarget = targets.find((t: any) => t.type === 'page' && t.url?.includes('deepseek'));
  if (!dsTarget) { console.log('No DeepSeek page'); process.exit(1); }
  
  const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${dsTarget.id}`);
  let id = 0;
  const pending = new Map<number, any>();
  await new Promise((r) => ws.onopen = r);
  
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!; pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = m.params?.args?.map((x: any) => x.value ?? '').join(' ');
      if (a.length > 5 && a.length < 300) console.log(`  [page] ${a}`);
    }
    if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/v0/chat/completion')) {
      console.log(`  <<< ${m.params.response.status} chat/completion`);
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
  await send('Page.enable');
  
  console.log('[1] Checking if on chat page...');
  const url = await send('Runtime.evaluate', { expression: 'location.href' });
  console.log(`    URL: ${url.result?.value}`);
  
  if (!url.result?.value?.includes('/chat')) {
    console.log('    Navigating to /chat...');
    await send('Page.navigate', { url: 'https://chat.deepseek.com/chat' });
    await new Promise(r => setTimeout(r, 8000));
  }
  
  // Get token
  const tok = await send('Runtime.evaluate', {
    expression: `(()=>{const r=localStorage.userToken;try{return JSON.parse(r).value||r}catch{return r}})()`
  });
  const token = tok.result?.value?.trim();
  console.log(`[2] Token: ${token.slice(0,30)}...`);
  
  // Check what's on the page — any fetch wrappers?
  console.log('[3] Searching for API client on page...');
  const inspect = await send('Runtime.evaluate', {
    expression: `(() => {
      const info = {};
      // Check for React state containers
      Object.keys(window).filter(k => {
        const v = window[k];
        if (!v || typeof v !== 'object') return false;
        if (k.startsWith('__')) info[k] = Object.keys(v).slice(0,5);
        return false;
      });
      
      // Is there a fetch wrapper or API client?
      // DeepSeek uses @tanstack/react-query — check for query cache
      info.hasFetch = typeof fetch === 'function';
      
      // Check if navigator has any service worker registration  
      info.sw = !!navigator.serviceWorker?.controller;
      
      return JSON.stringify(info);
    })()`
  });
  console.log(`    ${inspect.result?.value}`);
  
  // DIRECT APPROACH: Do the full flow on the page, using the ACTUAL browser's WASM
  // Navigate to a NEW blank tab, load WASM in a Worker (which works in browser!)
  console.log('\n[4] Creating new Worker in browser to solve PoW...');
  
  // Create workspace blob URL on the page
  const workerResult = await send('Runtime.evaluate', {
    expression: `(async () => {
      // Create inline Worker that loads WASM (WORKS in browser, NOT in Bun)
      const code = \`
        const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
        let wasmReady = null;
        
        async function ensureWasm() {
          if (wasmReady) return wasmReady;
          const resp = await fetch(WASM_URL);
          const bytes = await resp.arrayBuffer();
          const { instance } = await WebAssembly.instantiate(bytes, {});
          wasmReady = instance.exports;
          return wasmReady;
        }
        
        self.onmessage = async (e) => {
          const { challenge, salt, expireAt, difficulty } = e.data;
          try {
            const ex = await ensureWasm();
            const memory = ex.memory;
            memory.grow(10);
            
            const enc = new TextEncoder();
            const prefix = salt + '_' + expireAt + '_';
            const retptr = ex.__wbindgen_add_to_stack_pointer(-16);
            
            const cBytes = enc.encode(challenge);
            const pBytes = enc.encode(prefix);
            const dataOff = 131072;
            const prefOff = dataOff + cBytes.length + 32;
            
            new Uint8Array(memory.buffer, dataOff, cBytes.length).set(cBytes);
            new Uint8Array(memory.buffer, prefOff, pBytes.length).set(pBytes);
            
            ex.wasm_solve(retptr, dataOff, cBytes.length, prefOff, pBytes.length, difficulty);
            
            const view = new DataView(memory.buffer);
            const flag = view.getInt32(retptr, true);
            const answer = view.getFloat64(retptr + 8, true);
            ex.__wbindgen_add_to_stack_pointer(16);
            
            self.postMessage(flag !== 0 ? { answer } : { error: 'no solution' });
          } catch(err) {
            self.postMessage({ error: err.message });
          }
        };
      \`;
      
      const blob = new Blob([code], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      
      return new Promise((resolve) => {
        try {
          const worker = new Worker(blobUrl);
          const token = ${JSON.stringify(token)};
          
          // Get challenge  
          (async () => {
            const cRes = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
              method: 'POST', credentials: 'include',
              headers: {'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'},
              body: JSON.stringify({target_path: '/api/v0/chat/completion'}),
            });
            if (!cRes.ok) { resolve(JSON.stringify({error: 'challenge failed', status: cRes.status})); return; }
            const cBody = await cRes.json();
            const ch = cBody.data?.biz_data?.challenge || cBody.data;
            
            const timeout = setTimeout(() => {
              worker.terminate();
              resolve(JSON.stringify({error: 'worker timeout'}));
            }, 15000);
            
            worker.onmessage = (e) => {
              clearTimeout(timeout);
              worker.terminate();
              const d = e.data;
              
              if (d.answer !== undefined) {
                // Build x-ds-pow-response header
                const solution = {
                  algorithm: ch.algorithm,
                  challenge: ch.challenge,
                  salt: ch.salt,
                  answer: d.answer,
                  signature: ch.signature,
                  target_path: ch.target_path || '/api/v0/chat/completion',
                };
                const powHeader = btoa(JSON.stringify(solution));
                resolve(JSON.stringify({ answer: d.answer, powHeader: powHeader.slice(0,50)+'...' }));
              } else {
                resolve(JSON.stringify(d));
              }
            };
            
            worker.onerror = (e) => {
              clearTimeout(timeout);
              worker.terminate();
              resolve(JSON.stringify({error: 'worker error: ' + e.message}));
            };
            
            worker.postMessage({
              challenge: ch.challenge,
              salt: ch.salt,
              expireAt: ch.expire_at,
              difficulty: ch.difficulty,
            });
          })().catch(err => resolve(JSON.stringify({error: err.message})));
          
        } catch(e) {
          resolve(JSON.stringify({error: 'Worker creation failed: ' + e.message}));
        }
      });
    })()`,
    awaitPromise: true,
    timeout: 30000,
  });
  
  console.log(`\nPoW Worker result: ${workerResult.result?.value}`);
  
  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
