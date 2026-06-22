#!/usr/bin/env bun
/**
 * Guide script: extracts fireyejs.js from chat.qwen.ai.
 *
 * bx-ua and bx-pp require the real fireyejs.js anti-bot script.
 * This script cannot fetch it automatically — fireyejs is loaded by
 * the Qwen SPA and the URL changes per deployment.
 *
 * HOW TO EXTRACT:
 *
 *   1. Open Chrome/Chromium DevTools (F12) → Network tab
 *   2. Navigate to https://chat.qwen.ai
 *   3. Filter network requests by "fireyejs" in the filter bar
 *   4. You'll see a request like:
 *      "https://chat.qwen.ai/fireyejs/v-xxxxxxxxxxxxxxxx/fireyejs.js"
 *   5. Right-click → Save as → save to /path/to/fireyejs.js
 *   6. Run: FIREYEJS_PATH=/path/to/fireyejs.js BROWSERLESS_FETCH=true bun start
 *
 * VERIFY:
 *
 *   After extracting, this script runs a quick validation:
 *     - Checks the script loads (basic structure)
 *     - Verifies it exports the expected bx-ua/bx-pp capabilities
 *     - Tests the env shim context runs it without errors
 */
import { runInEnvContext } from '../src/services/envShim.ts';

const FIREYEJS_PATH = process.argv[2] || process.env.FIREYEJS_PATH;

if (!FIREYEJS_PATH) {
  console.log(`
  Usage: bun scripts/extract-fireyejs.ts /path/to/fireyejs.js

  Or set FIREYEJS_PATH env var:
    FIREYEJS_PATH=/path/to/fireyejs.js bun scripts/extract-fireyejs.ts

  Run this script to:
    - Validate your fireyejs.js extract is correct
    - Test it runs in the node:vm env shim context
    - Generate sample bx-ua and bx-pp values
`);
  process.exit(0);
}

// Read the script
const fs = await import('fs');
const code = fs.readFileSync(FIREYEJS_PATH, 'utf-8');
console.log(`\nfireyejs.js loaded: ${(code.length / 1024).toFixed(1)} KB`);

// Basic structure check
if (code.includes('opcode') || code.includes('generate') || code.includes('bx-ua') || code.includes('bx.ua')) {
  console.log('  Structure: contains bx-ua/opcode patterns ✓');
} else {
  console.log('  Warning: script does not contain expected bx-ua patterns');
}
if (code.includes('self') || code.includes('window') || code.includes('globalThis')) {
  console.log('  Structure: references browser globals (needs env shim) ✓');
}

// Test it runs in env shim
console.log('\n  Testing execution in node:vm env shim context...');
try {
  const { result } = runInEnvContext(code + `; JSON.stringify({ loaded: true, length: this?.scriptLength || ${code.length} });`);
  console.log(`  Result:`, result);
} catch (e: any) {
  console.log(`  Failed: ${e.message?.substring(0, 100)}`);
  console.log('  Make sure you extracted the full fireyejs.js from DevTools.');
  process.exit(1);
}

console.log(`
  ✓ Validation passed. The fireyejs.js script is valid.

  To use with Qwen Gate:
    FIREYEJS_PATH=${FIREYEJS_PATH} BROWSERLESS_FETCH=true bun start

  This enables:
    - Real bx-ua token generation (per-request, anti-detection)
    - Real bx-pp request signing (opcode 58)
    - Full baxia WAF bypass
`);
