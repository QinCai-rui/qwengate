/*
 * Test script: DeepSeek PoW challenge fetch + WASM solve diagnostics.
 *
 * Usage: DEEPSEEK_BEARER_TOKEN="<token>" bun run test-deepseek-pow.ts
 *
 * The token is stored in chat.deepseek.com localStorage as:
 *   JSON.parse(localStorage.getItem('userToken')).value
 */

process.env.DEEPSEEK_BEARER_TOKEN = 'U5VwHDCJM+vXwjBVzUGIJuJX5zM0fLKWgV9ex7+Akbxybs/utYqRzQPG1ANOGA5V';

import { getPowChallenge, solvePowViaWasm } from './src/routes/providers/deepseek/pow.ts';
import './src/services/logStore.ts';

const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

/* ------------------------------------------------------------------ */
/*  Step 1 — fetch a live PoW challenge                                */
/* ------------------------------------------------------------------ */
async function fetchChallenge(token: string) {
  console.log('[1/3] Requesting PoW challenge from DeepSeek ...');
  const challenge = await getPowChallenge(token, '/api/v0/chat/completion');
  if (!challenge) {
    console.error('FAIL: getPowChallenge() returned null');
    console.error('  -> Check bearer token validity, network, or DeepSeek API status');
    process.exit(1);
  }
  console.log('  algorithm   :', challenge.algorithm);
  console.log('  difficulty  :', challenge.difficulty);
  console.log('  challenge   :', challenge.challenge?.slice(0, 48) + '...');
  console.log('  salt        :', challenge.salt?.slice(0, 24) + '...');
  console.log('  signature   :', challenge.signature?.slice(0, 32) + '...');
  console.log('  expire_at   :', challenge.expire_at);
  console.log('  expire_after:', challenge.expire_after);
  return challenge;
}

/* ------------------------------------------------------------------ */
/*  Step 2 — diagnose WASM solvePowViaWasm                            */
/* ------------------------------------------------------------------ */
async function testOriginalSolver(challenge: any) {
  console.log('[2a/3] solvePowViaWasm (original implementation) ...');
  const answer = await solvePowViaWasm(challenge);
  console.log(`  result: ${answer !== null ? 'success answer=' + answer : 'null (failed)'}`);
  return answer;
}

/* ------------------------------------------------------------------ */
/*  Step 2b — low-level WASM diagnostic                               */
/* ------------------------------------------------------------------ */
async function diagnoseWasm(challenge: any) {
  console.log('[2b/3] WASM diagnosis ...');

  let wasmBytes: ArrayBuffer;
  try {
    const resp = await fetch(WASM_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    wasmBytes = await resp.arrayBuffer();
    console.log(`  WASM download: ${wasmBytes.byteLength} bytes OK`);
  } catch (e: any) {
    console.error(`  WASM download FAILED: ${e.message}`);
    return null;
  }

  let instance: WebAssembly.Instance;
  try {
    const result = await WebAssembly.instantiate(wasmBytes, {});
    instance = result.instance;
    console.log('  WebAssembly.instantiate: OK (no imports required)');
  } catch (e: any) {
    console.error(`  WebAssembly.instantiate FAILED: ${e.message}`);
    return null;
  }

  const exports = instance.exports as Record<string, any>;
  const funcKeys = Object.keys(exports).filter((k) => typeof exports[k] === 'function');
  const nonFuncKeys = Object.keys(exports).filter((k) => typeof exports[k] !== 'function');

  console.log(`  Exports: ${Object.keys(exports).length} total`);
  console.log(`    Functions: ${JSON.stringify(funcKeys)}`);
  console.log(`    Non-functions: ${JSON.stringify(nonFuncKeys)}`);

  for (let i = 0; i < 3; i++) {
    const name = `__wbindgen_export_${i}`;
    const val = exports[name];
    let info = `typeof=${typeof val}`;
    if (val !== undefined) info += ` constructor=${val.constructor?.name}`;
    if (typeof val === 'function') {
      try {
        val(0).catch?.((_: any) => {}); // Check if it's a thenable (WebAssembly.Table?)
      } catch {}
    }
    console.log(`    ${name}: ${info}`);
  }

  const memory = exports.memory as WebAssembly.Memory;
  const addToStack = exports.__wbindgen_add_to_stack_pointer as Function;
  const solveFn = exports.wasm_solve as Function;

  /* DIAGNOSTIC: Memory state */
  console.log(`  Memory: initial=${memory.buffer.byteLength} bytes (${memory.buffer.byteLength / 65536} pages)`);

  /* DIAGNOSTIC: Grow memory */
  const grown = memory.grow(2);
  if (grown === -1) {
    console.error('  Memory.grow(2): FAILED');
  } else {
    console.log(`  Memory.grow(2): OK, now ${memory.buffer.byteLength} bytes (${memory.buffer.byteLength / 65536} pages)`);
  }

  /* DIAGNOSTIC: Check if the __wbindgen_export_N are TABLE or FUNC */
  /* We check if they're callable by trying a simple invocation (may throw) */
  const allocNames = ['__wbindgen_export_0', '__wbindgen_export_1', '__wbindgen_export_2'];
  for (const name of allocNames) {
    const fn = exports[name] as Function;
    if (typeof fn !== 'function') {
      console.log(`  ${name}: not a function (typeof=${typeof fn})`);
      continue;
    }
    try {
      const result = fn(0, 0, 1, 16); // Try malloc/realloc(0,0,1,16)
      console.log(`  ${name}(0,0,1,16): returned ${result}`);
    } catch (e: any) {
      console.log(`  ${name}(0,0,1,16): threw "${e.message}"`);
    }
  }

  /* DIAGNOSTIC: Try addToStack + write data to grown memory + call wasm_solve */
  console.log('  Preparing data for wasm_solve call ...');
  const enc = new TextEncoder();
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const challengeHex = challenge.challenge;

  const DATA_OFFSET = 65536;
  const PREFIX_OFFSET = 66048;

  new Uint8Array(memory.buffer, DATA_OFFSET, challengeHex.length).set(enc.encode(challengeHex));
  new Uint8Array(memory.buffer, PREFIX_OFFSET, prefix.length).set(enc.encode(prefix));

  const retptr = addToStack(-16);
  console.log(`  Stack after retptr alloc: retptr=${retptr}`);
  console.log(`  Data: challenge@${DATA_OFFSET}(${challengeHex.length}) prefix@${PREFIX_OFFSET}(${prefix.length})`);
  console.log(
    `  Calling wasm_solve(${retptr}, ${DATA_OFFSET}, ${challengeHex.length}, ${PREFIX_OFFSET}, ${prefix.length}, ${challenge.difficulty}) ...`,
  );

  try {
    solveFn(retptr, DATA_OFFSET, challengeHex.length, PREFIX_OFFSET, prefix.length, challenge.difficulty);
    console.log('  wasm_solve returned (no exception)');

    const view = new DataView(memory.buffer);
    const flag = view.getInt32(retptr, true);
    const answer = view.getFloat64(retptr + 8, true);
    console.log(`  Return struct: flag=${flag} answer=${answer}`);

    return flag !== 0 ? answer : null;
  } catch (e: any) {
    console.error(`  wasm_solve threw: "${e.message}"`);
    return null;
  } finally {
    addToStack(16);
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */
const BEARER_TOKEN = process.env.DEEPSEEK_BEARER_TOKEN;
if (!BEARER_TOKEN) {
  console.error('FATAL: DEEPSEEK_BEARER_TOKEN env var is required');
  console.error('Get it from chat.deepseek.com localStorage:');
  console.error("  JSON.parse(localStorage.getItem('userToken')).value");
  process.exit(1);
}

async function main() {
  const challenge = await fetchChallenge(BEARER_TOKEN);

  // Original solver
  let answer = await testOriginalSolver(challenge);

  // WASM diagnostic
  answer = await diagnoseWasm(challenge);

  if (answer !== null) {
    console.log('');
    console.log('[3/3] PoW SOLVED!');
    console.log('  answer:', answer);
    console.log('');
    console.log('Challenge/Solution:', JSON.stringify({ challenge, solution: { answer } }, null, 2));
  } else {
    console.log('');
    console.log('[3/3] All solvers returned null — see diagnostics above');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
