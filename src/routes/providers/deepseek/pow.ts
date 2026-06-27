/*
 * File: providers/deepseek/pow.ts
 * DeepSeek Proof-of-Work (PoW) challenge solver.
 * DeepSeekHashV1 algorithm uses SHA3 WASM — we solve via browser profile or direct WASM loading.
 */

import { logStore } from '../../../services/logStore.ts';
import { DEEPSEEK_BASE_URL } from './spoofing.ts';

const POW_ENDPOINT = '/api/v0/chat/create_pow_challenge';
const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
  expire_after: number;
  target_path: string;
}

export interface PowSolution {
  algorithm: string;
  challenge: string;
  salt: string;
  answer: number;
  signature: string;
  target_path: string;
}

// ponytail: simple in-memory cache — keyed by (email, target_path)
interface PowCacheEntry {
  header: string;
  expiresAt: number;
}
const powResponseCache = new Map<string, PowCacheEntry>();

/**
 * Request a new PoW challenge from DeepSeek.
 * Requires Bearer token in authorization header.
 */
export async function getPowChallenge(
  bearerToken: string,
  targetPath: string = '/api/v0/chat/completion',
  cookies?: string,
): Promise<PowChallenge | null> {
  try {
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + bearerToken,
      'Content-Type': 'application/json',
    };
    if (cookies) headers['cookie'] = cookies;
    const res = await fetch(DEEPSEEK_BASE_URL + POW_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ target_path: targetPath }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const data = body.data || body;
    return {
      algorithm: data.algorithm || 'DeepSeekHashV1',
      challenge: data.challenge,
      salt: data.salt,
      signature: data.signature,
      difficulty: data.difficulty,
      expire_at: data.expire_at,
      expire_after: data.expire_after,
      target_path: data.target_path || targetPath,
    };
  } catch {
    return null;
  }
}

/**
 * Solve a PoW challenge using the browser profile (page.evaluate).
 * Opens a page, loads the DeepSeek WASM, and calls the solver function.
 */
export async function solvePowViaBrowser(email: string, challenge: PowChallenge): Promise<number | null> {
  try {
    const { setupBrowserContext } = await import('../../../services/browserProfiles.ts');
    const context = await setupBrowserContext(email, true);
    const page = context.pages()[0] || (await context.newPage());

    try {
      // Navigate to DeepSeek chat page so the WASM module is loaded in the page context
      await page.goto(DEEPSEEK_BASE_URL + '/chat', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });

      // Use JSON-serializable params to avoid template string issues
      const params = {
        challenge: challenge.challenge,
        salt: challenge.salt,
        signature: challenge.signature,
        difficulty: challenge.difficulty,
        wasmUrl: WASM_URL,
      };

      // Evaluate the PoW solver in the browser page context
      const answer: number = await page.evaluate(
        (p: { challenge: string; salt: string; signature: string; difficulty: number; wasmUrl: string }) => {
          return new Promise<number>((resolve, _reject) => {
            const timeout = setTimeout(() => {
              resolve(-1);
            }, 30000);

            // Fetch and instantiate the SHA3 WASM module
            fetch(p.wasmUrl)
              .then(function (r) {
                return r.arrayBuffer();
              })
              .then(function (bytes) {
                return WebAssembly.instantiate(bytes, {
                  env: { memory: new WebAssembly.Memory({ initial: 256 }) },
                });
              })
              .then(function (wasmResult) {
                const wasmExports: any = wasmResult.instance.exports;

                // Try to find the solve function (various possible export names)
                var solveFn = wasmExports.pow_solve || wasmExports.solve || wasmExports.pow_solve_js;

                if (typeof solveFn === 'function') {
                  // Try calling with string parameters directly (Rust WASM with &str params)
                  // The function expects (challenge_ptr, challenge_len, salt_ptr, salt_len, ...)
                  var enc = new TextEncoder();

                  function writeStr(mem: WebAssembly.Memory, str: string): number {
                    var buf = enc.encode(str);
                    var allocFn = wasmExports.__wbindgen_malloc || wasmExports.malloc;
                    if (!allocFn) return 0;
                    var ptr: number = allocFn(buf.length);
                    if (!ptr && ptr !== 0) return 0;
                    new Uint8Array(mem.buffer, ptr, buf.length).set(buf);
                    return ptr;
                  }

                  var mem: WebAssembly.Memory = wasmExports.memory;
                  if (!mem) {
                    // No memory export — try calling with raw strings
                    try {
                      var ans: number = solveFn(p.challenge, p.salt, p.signature, p.difficulty);
                      clearTimeout(timeout);
                      resolve(ans);
                      return;
                    } catch (_e) {
                      clearTimeout(timeout);
                      resolve(-1);
                      return;
                    }
                  }

                  var cPtr: number = writeStr(mem, p.challenge);
                  var sPtr: number = writeStr(mem, p.salt);
                  var sigPtr: number = writeStr(mem, p.signature);

                  try {
                    var ans: number = solveFn(cPtr, p.challenge.length, sPtr, p.salt.length, sigPtr, p.signature.length, p.difficulty);
                    clearTimeout(timeout);
                    resolve(ans);
                  } catch (_e) {
                    // Pure integer solve as last resort
                    try {
                      var ans: number = solveFn(p.challenge, p.salt, p.signature, p.difficulty);
                      clearTimeout(timeout);
                      resolve(ans);
                    } catch (_e2) {
                      clearTimeout(timeout);
                      resolve(-1);
                    }
                  }
                } else {
                  // No solve function found — try calling exports[0] as a catch-all
                  clearTimeout(timeout);
                  resolve(-1);
                }
              })
              .catch(function () {
                clearTimeout(timeout);
                resolve(-1);
              });
          });
        },
        params,
      );

      if (answer < 0) return null;
      return answer;
    } finally {
      await context.close().catch(function () {
        /* ignore */
      });
    }
  } catch {
    return null;
  }
}

/**
 * Solve PoW by loading WASM directly in Node.js (fallback).
 * Uses WebAssembly.instantiate to load the SHA3 WASM module and calls exported solve function.
 */
export async function solvePowViaWasm(challenge: PowChallenge): Promise<number | null> {
  try {
    const wasmBytes = await fetch(WASM_URL).then(function (r) {
      if (!r.ok) throw new Error('WASM fetch failed: ' + r.status);
      return r.arrayBuffer();
    });

    // wasm-pack generated modules expect env imports with memory
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 65536 });
    let heapBase = 1024;

    const importObj: Record<string, any> = {
      env: {
        memory: memory,
      },
    };
    // Add optional wbindgen imports needed by wasm-pack
    importObj.env.__wbindgen_throw = function (_ptr: number, _len: number) {
      // silent — PoW failures are non-fatal
    };
    importObj.env.__wbindgen_malloc = function (size: number) {
      var ptr = heapBase;
      heapBase += size;
      // Align to 8 bytes
      heapBase = (heapBase + 7) & ~7;
      return ptr;
    };
    importObj.env.__wbindgen_free = function (_ptr: number, _len: number) {
      // no-op — our simple allocator doesn't free
    };

    const { instance } = await WebAssembly.instantiate(wasmBytes, importObj);
    const exports = instance.exports as Record<string, Function>;

    // Find the solve function
    const solveFn = exports.pow_solve || exports.solve || exports.pow_solve_js;
    if (typeof solveFn !== 'function') {
      return null;
    }

    // Helper to write a string into WASM memory
    const enc = new TextEncoder();
    function writeString(str: string): number {
      var buf = enc.encode(str);
      var ptr = (importObj.env as any).__wbindgen_malloc(buf.length);
      new Uint8Array(memory.buffer, ptr, buf.length).set(buf);
      return ptr;
    }

    // Try calling with string pointers (wasm-bindgen convention)
    try {
      var cPtr = writeString(challenge.challenge);
      var sPtr = writeString(challenge.salt);
      var sigPtr = writeString(challenge.signature);
      var answer: any = (solveFn as Function)(
        cPtr,
        challenge.challenge.length,
        sPtr,
        challenge.salt.length,
        sigPtr,
        challenge.signature.length,
        challenge.difficulty,
      );
      if (typeof answer === 'number' && answer >= 0) return answer;
    } catch {
      // Try direct number-based call
    }

    // Fallback: try direct string pass (some WASM exports handle JS strings)
    try {
      var answer2: any = (solveFn as Function)(challenge.challenge, challenge.salt, challenge.signature, challenge.difficulty);
      if (typeof answer2 === 'number' && answer2 >= 0) return answer2;
    } catch {
      // WASM approach failed
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Full flow: get challenge + solve + return base64-encoded solution header.
 * Caches the solution for the challenge's expire_after ms to avoid re-solving.
 */
export async function getPowResponseHeader(
  email: string,
  bearerToken: string,
  targetPath: string = '/api/v0/chat/completion',
  cookies?: string,
): Promise<string | null> {
  var cacheKey = email + ':' + targetPath;
  var cached = powResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.header;
  }

  var challenge = await getPowChallenge(bearerToken, targetPath, cookies);
  if (!challenge) {
    logStore.log('warn', 'deepseek-pow', 'Failed to get PoW challenge');
    return null;
  }
  logStore.log('debug', 'deepseek-pow', `Challenge: difficulty=${challenge.difficulty} algorithm=${challenge.algorithm}`);

  var answer: number | null = null;

  // Try WASM direct first (fastest, no browser needed)
  answer = await solvePowViaWasm(challenge);
  logStore.log('debug', 'deepseek-pow', `WASM solver: ${answer !== null ? 'success' : 'failed'}`);

  // Fallback: try via browser profile
  if (answer === null) {
    answer = await solvePowViaBrowser(email, challenge);
    logStore.log('debug', 'deepseek-pow', `Browser solver: ${answer !== null ? 'success' : 'failed'}`);
  }

  if (answer === null) {
    logStore.log('warn', 'deepseek-pow', 'All PoW solvers failed');
    return null;
  }

  var solution: PowSolution = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer: answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };

  // Encode as base64 JSON for the x-ds-pow-response header
  var json = JSON.stringify(solution);
  var header = Buffer.from(json).toString('base64');

  // Cache until expire_after ms before the challenge expires
  var ttl = Math.min(challenge.expire_after || 120000, 120000);
  powResponseCache.set(cacheKey, { header: header, expiresAt: Date.now() + ttl });

  return header;
}
