// CDP: Navigate to /chat, WAIT for app to solve PoW, then use that cached PoW header
const CDP = 'http://127.0.0.1:9222';

async function main() {
  const info = await (await fetch(`${CDP}/json/version`)).json();
  const bw = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise(r => bw.onopen=r);
  let bid=0; const bmp=new Map();
  bw.onmessage = e => { const m=JSON.parse(e.data as string); if(m.id&&bmp.has(m.id)){const p=bmp.get(m.id)!;bmp.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};
  const bs = (m:string,p?:any)=>new Promise((res,rej)=>{const i=++bid;bmp.set(i,{resolve:res,reject:rej});bw.send(JSON.stringify({id:i,method:m,params:p}));setTimeout(()=>{if(bmp.has(i)){bmp.delete(i);rej(new Error('timeout'));}},20000);});

  // Create a fresh page
  const ct = await bs('Target.createTarget', { url: 'https://chat.deepseek.com/chat' });
  console.log(`Created page, target: ${ct.targetId.slice(0,8)}...`);
  bw.close();
  
  // Attach to it
  const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${ct.targetId}`);
  let id=0; const mp=new Map();
  await new Promise(r => ws.onopen=r);
  
  let capturedPowHeader: string | null = null;
  
  ws.onmessage = e => {
    const m = JSON.parse(e.data as string);
    if(m.id !== undefined && mp.has(m.id)) {
      const p=mp.get(m.id)!; mp.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    // CAPTURE PoW header from any request the page makes
    if(m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if(r.url.includes('/api/v0/chat/completion') && r.headers['x-ds-pow-response']) {
        capturedPowHeader = r.headers['x-ds-pow-response'];
        console.log(`\n🔑 CAPTURED PoW header from browser! (${capturedPowHeader.length} chars)`);
      }
    }
  };
  
  const send = (method:string, params?:any) => new Promise<any>((res,rej) => {
    const mi=++id; mp.set(mi,{resolve:res,reject:rej});
    ws.send(JSON.stringify({id:mi,method,params}));
    setTimeout(()=>{if(mp.has(mi)){mp.delete(mi);rej(new Error('timeout: '+method));}},45000);
  });
  
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');
  
  // Wait for page to load
  console.log('Waiting for page to load (15s)...');
  await new Promise(r => setTimeout(r, 15000));
  
  // Check page state
  const urlRes = await send('Runtime.evaluate', { expression: 'location.href' });
  console.log(`URL: ${urlRes.result?.value}`);
  
  if (urlRes.result?.value?.includes('sign_in')) {
    console.log('On sign_in page. Injecting token into localStorage...');
    
    // Get token from auth.json
    const authData = await Bun.file('.auth/auth.json').json();
    const dsAcct = authData.find((a:any)=>a.providerStates?.deepseek?.cookies);
    const cookies = dsAcct?.providerStates?.deepseek?.cookies || '';
    
    // Set cookies
    if (cookies) {
      const cookieList = cookies.split('; ').map((c:string)=>{
        const eq=c.indexOf('=');
        return {name:c.slice(0,eq),value:c.slice(eq+1),domain:'.deepseek.com',path:'/'};
      });
      await send('Network.setCookies', { cookies: cookieList });
      console.log(`Set ${cookieList.length} cookies`);
    }
    
    // Reload
    await new Promise(r => setTimeout(r, 2000));
    await send('Page.navigate', { url: 'https://chat.deepseek.com/chat' });
    await new Promise(r => setTimeout(r, 15000));
    
    const urlRes2 = await send('Runtime.evaluate', { expression: 'location.href' });
    console.log(`After cookie injection: ${urlRes2.result?.value}`);
  }
  
  // Is the page now on /chat (not sign_in)?
  const finalUrl = await send('Runtime.evaluate', { expression: 'location.href' });
  console.log(`Final URL: ${finalUrl.result?.value}`);
  
  if (!finalUrl.result?.value?.includes('sign_in') && !finalUrl.result?.value?.includes('login')) {
    // Success! Send a message via UI to trigger PoW solve
    console.log('\n⏳ Sending message via UI to trigger PoW solve...');
    
    await send('Runtime.evaluate', {
      expression: `
        (() => {
          const ta = document.querySelector('textarea');
          if (!ta) return 'NO TEXTAREA';
          ta.focus();
          ta.value = 'Say hello.';
          ta.dispatchEvent(new Event('input', {bubbles:true}));
          setTimeout(() => {
            const btn = ta.closest('form')?.querySelector('button[type="submit"]') 
              || document.querySelector('[data-testid="send-button"]');
            if (btn) btn.click();
          }, 1000);
          return 'sent';
        })()
      `
    });
    
    console.log('Waiting 15s for response...');
    await new Promise(r => setTimeout(r, 15000));
  }
  
  if (capturedPowHeader) {
    console.log(`\n✅ CAPTURED PoW header!`);
    await Bun.write('.auth/deepseek-pow-live.txt', capturedPowHeader);
  } else {
    console.log('\n❌ No PoW header captured');
  }
  
  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
