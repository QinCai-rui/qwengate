// @ts-nocheck
// Test: navigate existing CDP page to /chat, type message, send, read response
const CDP = 'http://127.0.0.1:9222';
(async()=>{
  const ts = await fetch(`${CDP}/json`).then(r=>r.json());
  const dt = ts.find((t:any)=>t.type==='page'&&t.url?.includes('deepseek'));
  if(!dt){console.log('No page');process.exit(1)}
  
  const ws=new WebSocket(`ws://127.0.0.1:9222/devtools/page/${dt.id}`);
  let id=0;const mp=new Map();
  await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&mp.has(m.id)){const h=mp.get(m.id)!;mp.delete(m.id);m.error?h.rj(Error(JSON.stringify(m.error))):h.rs(m.result)}};
  const send=(m,p?)=>new Promise((rs,rj)=>{const i=++id;mp.set(i,{rs,rj});ws.send(JSON.stringify({id:i,method:m,params:p}));setTimeout(()=>{if(mp.has(i)){mp.delete(i);rj(Error('timeout:'+m))}},25000)});
  
  await send('Runtime.enable');
  await send('Page.enable');
  
  // Navigate and wait
  console.log('Navigating to /chat...');
  await send('Page.navigate',{url:'https://chat.deepseek.com/chat'});
  await new Promise(r=>setTimeout(r,12000));
  
  const url=await send('Runtime.evaluate',{expression:'location.href'});
  console.log('URL:',url.result?.value);
  
  if(url.result?.value?.includes('sign_in')){console.log('NOT LOGGED IN');process.exit(1)}
  
  // Type and send
  console.log('Typing message...');
  await send('Runtime.evaluate',{expression:`
    (()=>{
      const ta=document.querySelector('textarea');
      if(!ta)return'NO TEXTAREA';
      ta.focus();
      const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      s?s.call(ta,'Say hello in 3 words.'):ta.value='Say hello in 3 words.';
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      setTimeout(()=>{
        const btn=document.querySelector('[data-testid="send-button"]')||ta.closest('form')?.querySelector('button[type="submit"]');
        if(btn)btn.click();else ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      },1000);
      return'sent';
    })()
  `});
  
  console.log('Waiting for response...');
  let content='';
  for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,1500));
    const r=await send('Runtime.evaluate',{expression:`(()=>{
      const ms=document.querySelectorAll('.ds-markdown,[class*="markdown"]');
      if(!ms.length)return '';
      const last=ms[ms.length-1];
      return last?.textContent?.trim()||'';
    })()`});
    content=r.result?.value||'';
    if(content&&content.length>30&&!content.includes(prompt?.slice(0,10)))break;
    if(i%5===0)console.log(`  poll ${i}: "${content?.slice(0,40)}"`);
  }
  console.log(`\nResponse: "${content}"`);
  ws.close();
})().catch(e=>console.error('FATAL:',e.message));
