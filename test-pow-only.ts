// Quick test: fix WASM solver by bypassing allocator (write directly to memory)
const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

async function main() {
  // Fetch a PoW challenge
  const token = await Bun.file('.auth/deepseek-token.txt').text();
  
  console.log('[1] Fetching challenge...');
  const cRes = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });
  const cBody = await cRes.json();
  const ch = cBody.data?.biz_data?.challenge || cBody.data;
  console.log(`  difficulty: ${ch.difficulty}, salt: ${ch.salt}`);

  // Load WASM
  console.log('[2] Loading WASM...');
  const wasmBytes = await fetch(WASM_URL).then(r => r.arrayBuffer());
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const exports = instance.exports as any;
  const memory = exports.memory as WebAssembly.Memory;
  
  // Bypass allocator: write data directly at fixed offsets
  const enc = new TextEncoder();
  const prefix = ch.salt + '_' + ch.expire_at + '_';
  
  // Use offsets in the WASM memory's initial pages
  const CHALLENGE_OFFSET = 65536;
  const PREFIX_OFFSET = 66048;
  
  // Grow memory if needed
  if (memory.buffer.byteLength < PREFIX_OFFSET + prefix.length) {
    memory.grow(Math.ceil((PREFIX_OFFSET + prefix.length - memory.buffer.byteLength) / 65536));
  }
  
  const mem = new Uint8Array(memory.buffer);
  mem.set(enc.encode(ch.challenge), CHALLENGE_OFFSET);
  mem.set(enc.encode(prefix), PREFIX_OFFSET);
  
  // Allocate return struct space
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  console.log(`  retptr: ${retptr}`);
  
  // Call wasm_solve
  console.log(`[3] Solving (difficulty=${ch.difficulty})...`);
  exports.wasm_solve(retptr, CHALLENGE_OFFSET, ch.challenge.length, PREFIX_OFFSET, prefix.length, ch.difficulty);
  
  const view = new DataView(memory.buffer);
  const flag = view.getInt32(retptr, true);
  const answer = view.getFloat64(retptr + 8, true);
  
  exports.__wbindgen_add_to_stack_pointer(16); // restore
  
  if (flag === 0) {
    console.log('  FAILED: no solution found (flag=0)');
  } else {
    console.log(`  SUCCESS! answer=${answer}`);
    
    // Build the x-ds-pow-response header
    const solution = {
      algorithm: ch.algorithm,
      challenge: ch.challenge,
      salt: ch.salt,
      answer: answer,
      signature: ch.signature,
      target_path: ch.target_path || '/api/v0/chat/completion',
    };
    const header = Buffer.from(JSON.stringify(solution)).toString('base64');
    console.log(`  x-ds-pow-response: ${header.slice(0, 50)}...`);
    await Bun.write('.auth/deepseek-pow-header.txt', header);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
