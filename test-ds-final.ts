// CDP: Inject token into localStorage, navigate, do full chat flow via page's own fetch
const CDP = 'http://127.0.0.1:9222';

async function main() {
  const info = await (await fetch(`${CDP}/json/version`)).json();
  const bw = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise(r => bw.onopen=r);
  let bid=0; const bmp=new Map();
  bw.onmessage = e => {
    const m=JSON.parse(e.data as string);
    if(m.id&&bmp.has(m.id)){const p=bmp.get(m.id)!;bmp.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
  };
  const bs = (m:string,p?:any)=>new Promise((res,rej)=>{
    const i=++bid;bmp.set(i,{resolve:res,reject:rej});
    bw.send(JSON.stringify({id:i,method:m,params:p}));
    setTimeout(()=>{if(bmp.has(i)){bmp.delete(i);rej(new Error('timeout'));}},20000);
  });

  // Get token from existing page or account
  const targets = await (await fetch(`${CDP}/json`)).json() as any[];
  let dsPage = targets.find((t:any)=>t.type==='page'&&t.url?.includes('deepseek'));
  if (dsPage) {
    console.log(`Using existing page: ${dsPage.url}`);
    const pageWs = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${dsPage.id}`);
    await new Promise(r=>pageWs.onopen=r);
    let pid=0;const pmp=new Map();
    pageWs.onmessage = e=>{
      const m=JSON.parse(e.data as string);
      if(m.id&&pmp.has(m.id)){const p=pmp.get(m.id)!;pmp.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
    };
    const ps=(m:string,p?:any)=>new Promise((res,rej)=>{
      const i=++pid;pmp.set(i,{resolve:res,reject:rej});
      pageWs.send(JSON.stringify({id:i,method:m,params:p}));
      setTimeout(()=>{if(pmp.has(i)){pmp.delete(i);rej(new Error('timeout'));}},15000);
    });
    await ps('Runtime.enable');
    const tok = await ps('Runtime.evaluate',{
      expression:`(()=>{const r=localStorage.userToken;try{return JSON.parse(r).value||r}catch{return r}})()`
    });
    const token = tok.result?.value?.trim();
    console.log(`Token: ${token?.slice(0,30)||'none'}...`);
    pageWs.close();
    bw.close();
    return;
  }

  // Create new page and inject token
  console.log('Creating new page...');
  const ct = await bs('Target.createTarget', { url: 'https://chat.deepseek.com/' });
  
  // Get auth data
  const authData = await Bun.file('.auth/auth.json').json();
  const dsAcct = authData.find((a:any)=>a.providerStates?.deepseek?.cookies);
  const cookies = dsAcct?.providerStates?.deepseek?.cookies || '';
  
  const pageWs = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${ct.targetId}`);
  await new Promise(r=>pageWs.onopen=r);
  let pid=0;const pmp=new Map();
  pageWs.onmessage = e=>{
    const m=JSON.parse(e.data as string);
    if(m.id&&pmp.has(m.id)){const p=pmp.get(m.id)!;pmp.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);return;}
  };
  const ps=(m:string,p?:any)=>new Promise((res,rej)=>{
    const i=++pid;pmp.set(i,{resolve:res,reject:rej});
    pageWs.send(JSON.stringify({id:i,method:m,params:p}));
    setTimeout(()=>{if(pmp.has(i)){pmp.delete(i);rej(new Error('timeout'));}},15000);
  });

  await ps('Runtime.enable');
  await ps('Network.enable');
  
  // Wait for page load
  await new Promise(r=>setTimeout(r,4000));
  
  // Set cookies
  if (cookies) {
    const cookieList = cookies.split('; ').map((c:string)=>{
      const eq=c.indexOf('=');
      return {name:c.slice(0,eq),value:c.slice(eq+1),domain:'.deepseek.com',path:'/'};
    });
    await ps('Network.setCookies', { cookies: cookieList });
    console.log(`Set ${cookieList.length} cookies`);
  }

  // Navigate to /chat
  console.log('Navigating to /chat...');
  await ps('Page.navigate', { url: 'https://chat.deepseek.com/chat' });
  await new Promise(r=>setTimeout(r,10000));
  
  const urlCheck = await ps('Runtime.evaluate', { expression: 'location.href' });
  console.log(`URL: ${urlCheck.result?.value}`);
  
  if (urlCheck.result?.value?.includes('sign_in')) {
    console.log('Sign-in detected. Looking for token...');
    // Try to get token from cookies via fetch
    const tokenCheck = await ps('Runtime.evaluate', {
      expression: `(async()=>{
        try{
          const r=await fetch('https://chat.deepseek.com/api/v0/users/current',{method:'GET',credentials:'include'});
          return JSON.stringify({status:r.status,ok:r.ok});
        }catch(e){return JSON.stringify({error:e.message});}
      })()`
    , awaitPromise:true, timeout:10000});
    console.log(`Token check: ${tokenCheck.result?.value}`);
  }
  
  pageWs.close();
  bw.close();
}

main().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
