// Fix: bypass allocator, write directly to WASM heap at safe offsets
const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

async function main() {
  const token = (await Bun.file('.auth/deepseek-token.txt').text()).trim();
  
  // Get challenge
  const cRes = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });
  const cBody = await cRes.json();
  const ch = cBody.data?.biz_data?.challenge || cBody.data;
  console.log(`diff=${ch.difficulty}`);
  
  // Load WASM
  const bytes = await fetch(WASM_URL).then(r => r.arrayBuffer());
  
  // Try instantiating with use of 'wasi_snapshot_preview1' (no-imports path was already tried)
  // The issue: __wbindgen_start crashes calling __wbindgen_export_2 indirectly.
  // __wbindgen_export_2 is probably a no-op/finalizer - let's provide it as import.
  
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: {
      // Provide a dummy for anything the module might need
      __wbindgen_export_2: () => {},
    }
  });
  
  const ex = instance.exports as any;
  const memory = ex.memory as WebAssembly.Memory;
  const solveFn = ex.wasm_solve;
  const addToStack = ex.__wbindgen_add_to_stack_pointer as Function;
  
  console.log('memory:', memory.buffer.byteLength);
  console.log('solveFn:', typeof solveFn);
  
  // Grow memory to be safe
  memory.grow(10); // 10 more pages = 640KB
  console.log('memory after grow:', memory.buffer.byteLength);
  
  // Write data at fixed offsets (well past where __wbindgen_start would allocate)
  const enc = new TextEncoder();
  const prefix = ch.salt + '_' + ch.expire_at + '_';
  const cBytes = enc.encode(ch.challenge);
  const pBytes = enc.encode(prefix);
  
  // Use offsets far from the default heap base
  const CHALLENGE_OFFSET = 131072;   // 128KB
  const PREFIX_OFFSET = 131200;       // ~128KB + 128
  
  const mem = new Uint8Array(memory.buffer);
  mem.set(cBytes, CHALLENGE_OFFSET);
  mem.set(pBytes, PREFIX_OFFSET);
  
  // Allocate stack
  const retptr = addToStack(-16);
  console.log(`retptr=${retptr}`);
  
  try {
    solveFn(retptr, CHALLENGE_OFFSET, cBytes.length, PREFIX_OFFSET, pBytes.length, ch.difficulty);
    
    const view = new DataView(memory.buffer);
    const flag = view.getInt32(retptr, true);
    const answer = view.getFloat64(retptr + 8, true);
    
    console.log(`flag=${flag} answer=${answer}`);
    
    if (flag !== 0) {
      console.log(`✅ SOLVED! answer=${answer}`);
      const sol = { algorithm: ch.algorithm, challenge: ch.challenge, salt: ch.salt, answer, signature: ch.signature, target_path: ch.target_path };
      const header = Buffer.from(JSON.stringify(sol)).toString('base64');
      await Bun.write('.auth/deepseek-pow-header2.txt', header);
    }
  } catch(e: any) {
    console.log('FAILED:', e.message);
  } finally {
    addToStack(16);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
