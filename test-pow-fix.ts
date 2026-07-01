const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

async function main() {
  const token = (await Bun.file('.auth/deepseek-token.txt').text()).trim();
  
  const cRes = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });
  const cBody = await cRes.json();
  const ch = cBody.data?.biz_data?.challenge || cBody.data;
  console.log(`diff=${ch.difficulty} salt=${ch.salt}`);

  const wasmBytes = await fetch(WASM_URL).then(r => r.arrayBuffer());
  const wasmModule = await WebAssembly.compile(wasmBytes);
  
  // Inspect the module: what imports does it expect?
  const imports = WebAssembly.Module.imports(wasmModule);
  const exports = WebAssembly.Module.exports(wasmModule);
  console.log('Imports:', JSON.stringify(imports.map((i:any) => `${i.module}.${i.name} (${i.kind})`)));
  console.log('Exports:', JSON.stringify(exports.filter((e:any) => e.kind === 'function').map((e:any) => e.name)));
  
  // The WASM module expects NO imports (self-contained). The realloc() call fails 
  // because __wbindgen_export_1 expects old_ptr=0, old_size=0, align=1, new_size=len
  // but the WASM's memory management is internal realloc.
  // 
  // From browser capture: the browser calls wasm_solve with pre-allocated buffers.
  // Let's provide a dummy import env that has no exports (self-contained module).
  
  const { instance } = await WebAssembly.instantiate(wasmModule, {});
  const ex = instance.exports as any;
  const memory = ex.memory as WebAssembly.Memory;
  
  // Strategy: write data directly at known safe offsets in WASM heap
  // __wbindgen_add_to_stack_pointer(-16) returns a stack pointer in the WASM heap
  // We write our data ABOVE the stack return area
  
  const enc = new TextEncoder();
  const challengeBytes = enc.encode(ch.challenge);
  const prefixBytes = enc.encode(ch.salt + '_' + ch.expire_at + '_');
  
  // Reserve stack space for return struct (16 bytes)
  const stackPtr = ex.__wbindgen_add_to_stack_pointer(-16);
  console.log(`stackPtr=${stackPtr} memory=${memory.buffer.byteLength}`);
  
  // Make sure memory is big enough for our data past the stack
  const neededTotal = Math.max(stackPtr, 0) + 16 + challengeBytes.length + prefixBytes.length + 128;
  if (memory.buffer.byteLength < neededTotal) {
    const pages = Math.ceil((neededTotal - memory.buffer.byteLength) / 65536);
    memory.grow(pages);
    console.log(`grew memory by ${pages} pages, now ${memory.buffer.byteLength} bytes`);
  }
  
  // Write data into WASM memory above the stack
  const challengePtr = stackPtr + 16; // past return struct
  const prefixPtr = challengePtr + challengeBytes.length;
  
  const mem = new Uint8Array(memory.buffer);
  mem.set(challengeBytes, challengePtr);
  mem.set(prefixBytes, prefixPtr);
  
  console.log(`challenge@${challengePtr}(${challengeBytes.length}B) prefix@${prefixPtr}(${prefixBytes.length}B)`);
  
  try {
    ex.wasm_solve(stackPtr, challengePtr, challengeBytes.length, prefixPtr, prefixBytes.length, ch.difficulty);
    
    const view = new DataView(memory.buffer);
    const flag = view.getInt32(stackPtr, true);
    const answer = view.getFloat64(stackPtr + 8, true);
    
    console.log(`flag=${flag} answer=${answer}`);
    
    if (flag !== 0) {
      const solution = {
        algorithm: ch.algorithm,
        challenge: ch.challenge,
        salt: ch.salt,
        answer: answer,
        signature: ch.signature,
        target_path: ch.target_path || '/api/v0/chat/completion',
      };
      const header = Buffer.from(JSON.stringify(solution)).toString('base64');
      console.log(`SOLVED! header: ${header.slice(0,50)}...`);
      await Bun.write('.auth/deepseek-pow-header.txt', header);
    }
  } finally {
    ex.__wbindgen_add_to_stack_pointer(16);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
