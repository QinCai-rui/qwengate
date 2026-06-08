import test from "node:test";
import assert from "node:assert";
import {
  stripToolCallArtifacts,
  stripStreamingDelta,
} from "./utils/xmlStripper.ts";

const TRC = "<" + "/tool_result>";

function streamPipeline(chunks: string[]): string {
  let acc = "";
  for (const c of chunks) {
    acc += stripStreamingDelta(c);
  }
  return stripToolCallArtifacts(acc);
}

// ── EXACT real log replay ──────────────────────────────────────────────
// Each element is one line from logs/2026-6-4_17-57-2/chunk_stream.txt
const REAL_CHUNKS_17_57_2 = [
  "All 1",
  "0 tools",
  " tested successfully. Now",
  " testing the remaining file",
  "-modification tools.",
  "",
  "",
  '{"',
  'name": "write',
  '", "arguments":',
  '  {"content": "',
  "tool",
  '  test file", "',
  'filePath":',
  '  "/tmp/kilo',
  '/tool_test.txt"}}',
  "",
  "</tool_result",
  ">",
  "",
  "",
  '{"name": "',
  'read", "arguments',
  '": {"filePath":',
  '  "/tmp/kilo',
  '/tool_test.txt"}}',
  "",
  "</tool_result",
  ">",
  "",
  '{"name',
  '": "edit",',
  '  "arguments": {"',
  'filePath": "/tmp',
  "/kilo/tool_test",
  '.txt", "old',
  'String": "tool',
  '  test file", "',
  'newString": "',
  'tool test passed"}}',
  "",
  "</tool_result",
  ">",
  "",
  '{"name',
  '": "read",',
  '  "arguments": {"',
  'filePath": "/tmp',
  "/kilo/tool_test",
  '.txt"}}',
  "</",
  "tool_result>",
  "",
  "",
  '{"name": "',
  'bash", "arguments',
  '": {"command":',
  '  "rm /tmp',
  "/kilo/tool_test",
  '.txt", "description',
  '": "Clean up',
  '  test file"}}',
  "",
  "</tool_result>",
  "",
  "",
  "All 1",
  "5 tools verified:",
  "",
  "",
  "| Tool",
  " | Status |",
  "",
  "|---|---|",
  "",
  "|",
  "",
  "| `bash`",
  " | Working |",
  "",
  "| `read`",
  " | Working |",
  "",
  "| `glob`",
  " | Working |",
  "",
  "| `grep`",
  " | Working |",
  "",
  "| `edit`",
  " | Working |",
  "",
  "| `write`",
  " | Working |",
  "",
  "| `webfetch",
  "` | Working",
  " |",
  "| `",
  'task` | Working',
  " |",
  "",
  "| `tod",
  "owrite` |",
  " Working |",
  "|",
  "  `skill` |",
  "  Working |",
  "|",
  '  `kilo_local',
  "_recall` | Working",
  " |",
  "| `",
  "background_process` |",
  "  Working |",
  "|",
  '  `question` |',
  "  Available (requires user",
  "  interaction) |",
  "",
  "| `plan",
  "_exit` | Available",
  "  (planning-specific",
  ") |",
  "|",
  '  `suggest` |',
  "  Available (review-specific",
  ") |",
];

// ── TEST 1: Exact replay of 127-chunk real log ────────────────────────
test("REAL-FULL: 127-chunk exact replay — no artifacts, all text preserved", () => {
  const result = streamPipeline(REAL_CHUNKS_17_57_2);

  // No tool call artifacts survive
  assert.ok(!result.includes(TRC), `</tool_result> tag leaked`);
  assert.ok(!result.includes("</"), `Bare </ leaked`);
  assert.ok(!result.includes("tool_result"), `tool_result text leaked`);
  assert.ok(!result.includes('"name"'), `JSON name key leaked`);
  assert.ok(!result.includes('"arguments"'), `JSON arguments key leaked`);

  // Opening text preserved exactly
  assert.ok(
    result.startsWith("All 10 tools tested successfully"),
    `Opening text corrupted: ${JSON.stringify(result.slice(0, 60))}`,
  );

  // No tool call content
  assert.ok(!result.includes("/tmp/kilo"), `Tool filePath leaked`);

  // Closing table present and correct
  assert.ok(result.includes("All 15 tools verified"), `Table header lost`);
  assert.ok(result.includes("| Tool | Status |"), `Table row Tool lost`);
  assert.ok(result.includes("| `bash` | Working |"), `Table row bash lost`);
  assert.ok(result.includes("| `read` | Working |"), `Table row read lost`);

  // No malformed table artifacts
  const lines = result.split("\n");
  const barePipeLines = lines.filter((l) => /^\|$/.test(l.trim()));
  assert.ok(barePipeLines.length === 0, `Bare pipe rows leaked: ${JSON.stringify(barePipeLines)}`);

  // No consecutive empty lines beyond 2
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i] === "" && lines[i + 1] === "" && lines[i + 2] === "") {
      assert.fail(`Triple empty lines at line ${i}: ${JSON.stringify(lines.slice(i, i + 5))}`);
    }
  }
});

// ── TEST 2: </ split from tool_result> by newline ─────────────────────
test("REAL-1: </ + newline + tool_result> across chunk boundary", () => {
  const chunks = [
    '{"name": "bash", "arguments": {"command": "rm /tmp/x"}}\n',
    "</\n",
    "tool_result>\n\n",
    "Done.\n",
  ];
  const result = streamPipeline(chunks);
  assert.ok(!result.includes("</"), `</ leaked: ${JSON.stringify(result)}`);
  assert.ok(!result.includes("tool_result"), `tool_result leaked`);
  assert.ok(result.includes("Done"), `Post-text lost`);
});

// ── TEST 3: </tool_result split from > by newline ─────────────────────
test("REAL-1b: </tool_result + newline + > across chunks", () => {
  const chunks = [
    '{"name": "read", "arguments": {"filePath": "/tmp"}}\n',
    "</tool_result\n",
    ">\n\n",
    "Done.\n",
  ];
  const result = streamPipeline(chunks);
  assert.ok(!result.includes("</tool_result"), `Partial tag leaked: ${JSON.stringify(result)}`);
  assert.ok(!result.includes("tool_result"), `tool_result text leaked`);
  assert.ok(result.includes("Done"), `Post-text lost`);
});

// ── TEST 4: JSON property name and value across 6 chunks ──────────────
test("REAL-2: JSON key split mid-word, value split across many chunks", () => {
  const chunks = [
    '{"name": "write", "arguments": {"content": "tool',
    ' test file", "',
    'filePath":',
    '  "/tmp/kilo',
    '/tool_test.txt"}}\n',
    TRC + "\n",
  ];
  const result = streamPipeline(chunks);
  assert.ok(!result.includes("write"), `Tool name leaked`);
  assert.ok(!result.includes("/tmp/kilo"), `Path leaked`);
  assert.ok(!result.includes(TRC), `Tag leaked`);
});

// ── TEST 5: Three tool calls with </tool_result> between each ─────────
test("REAL-5: edit + read + bash with tags between, no output leaks", () => {
  const chunks = [
    'Starting.\n\n{"name": "edit", "arguments": {"filePath": "/tmp/a", "oldString": "x", "newString": "y"}}\n',
    TRC + "\n\n",
    '{"name": "read", "arguments": {"filePath": "/tmp/a"}}\n',
    TRC + "\n\n",
    '{"name": "bash", "arguments": {"command": "rm /tmp/a"}}\n',
    TRC + "\n\n",
    "Complete.\n",
  ];
  const result = streamPipeline(chunks);
  assert.ok(!result.includes("/tmp/a"), `Tool path leaked`);
  assert.ok(!result.includes(TRC), `Tag leaked`);
  assert.ok(result.startsWith("Starting."), `Pre-text lost`);
  assert.ok(result.trim().endsWith("Complete."), `Post-text or extra content at end`);
  assert.strictEqual(result.trim(), "Starting.\n\nComplete.", `Unexpected extra content`);
});

// ── TEST 6: Number split mid-digit ────────────────────────────────────
test("REAL-6: 'All 1' + '0 tools' merges to 'All 10 tools'", () => {
  const chunks = ["All ", "1", "0 tools", " tested successfully.\n"];
  const result = streamPipeline(chunks);
  assert.ok(
    result.includes("All 10 tools tested successfully"),
    `Number merged incorrectly: ${JSON.stringify(result)}`,
  );
});

// ── TEST 7: Markdown table with bare pipe artifacts ───────────────────
test("REAL-7: markdown table pipes split across chunks produce clean table", () => {
  const chunks = [
    "| Tool",
    " | Status |",
    "",
    "|---|---|",
    "",
    "|",
    "",
    "| `bash`",
    " | Working |",
  ];
  const result = streamPipeline(chunks);
  assert.ok(result.includes("| Tool | Status |"), `Header malformed: ${JSON.stringify(result)}`);
  assert.ok(result.includes("| `bash` | Working |"), `Row malformed: ${JSON.stringify(result)}`);
  assert.ok(!result.includes("|  `bash`"), `Extra space before backtick`);
});

// ── TEST 8: 2-chunk response exact match ──────────────────────────────
test("REAL-8: two-chunk response reassembles perfectly", () => {
  const chunks = ["Task subagent is", " working correctly.\n"];
  const result = streamPipeline(chunks);
  assert.strictEqual(
    result.trim(),
    "Task subagent is working correctly.",
    `Short text wrong: ${JSON.stringify(result)}`,
  );
});

// ── TEST 9: Consecutive tool calls no separator, only tool calls ──────
test("REAL-9: three tool calls no separator — output must be empty", () => {
  const chunks = [
    '{"name": "bash", "arguments": {"command": "echo hi"}}\n{"name": "read", "arguments": {"filePath": "/tmp"}}\n',
    '{"name": "glob", "arguments": {"pattern": "*"}}\n',
  ];
  const result = streamPipeline(chunks);
  assert.ok(!result.includes("echo hi"), `echo leaked: ${JSON.stringify(result)}`);
  assert.ok(!result.includes("/tmp"), `/tmp leaked: ${JSON.stringify(result)}`);
  assert.strictEqual(result.trim(), "", `Should be empty: ${JSON.stringify(result)}`);
});

// ── TEST 10: Text before and after tool call, both preserved ──────────
test("REAL-10: pre and post text both survive, tool content gone", () => {
  const chunks = [
    "Start.\n\n",
    '{"name": "bash", "arguments": {"command": "echo hi"}}\n',
    TRC + "\n\n",
    "End.\n",
  ];
  const result = streamPipeline(chunks);
  assert.ok(result.startsWith("Start."), `Pre-text lost`);
  assert.ok(result.trim().endsWith("End."), `Post-text lost`);
  assert.ok(!result.includes("echo"), `Tool content leaked`);
  assert.strictEqual(result.trim(), "Start.\n\nEnd.", `Extra content: ${JSON.stringify(result)}`);
});

// ── TEST 11: Property name split mid-word ─────────────────────────────
test("REAL-11: 'old' + 'String' key split across chunks", () => {
  const chunks = [
    '{"name": "edit", "arguments": {"filePath": "/tmp/x", "old',
    'String": "x", "newString": "y"}}\n',
  ];
  const result = streamPipeline(chunks);
  assert.ok(!result.includes("edit"), `Tool name leaked`);
  assert.ok(!result.includes("/tmp/x"), `Path leaked`);
});

// ── TEST 12: Key starting chunk, colon on next ────────────────────────
test("REAL-12: 'name' key in one chunk, ': \"read\"' in next", () => {
  const chunks = [
    '{"name',
    '": "read",',
  ];
  const result = streamPipeline(chunks);
  assert.ok(!result.includes("read"), `Tool name leaked`);
});

// ── TEST 13: Opening brace in own chunk before full JSON ──────────────
test("REAL-13: '{' as its own chunk before tool call JSON", () => {
  const chunks = [
    "List:\n\n{",
    '"name": "grep", "arguments": {"pattern": "graphify", "include": "*.md"}}\n',
  ];
  const result = streamPipeline(chunks);
  assert.ok(result.startsWith("List:"), `Pre-text lost: ${JSON.stringify(result)}`);
  assert.ok(!result.includes("grep"), `Tool name leaked`);
  assert.ok(!result.includes("graphify"), `Pattern leaked`);
});

// ── TEST 14: Tool call with no name field (function format) ───────────
test("REAL-14: function format without name field stripped", () => {
  const chunks = [
    '{"function": "bash", "arguments": {"command": "ls"}}\n',
  ];
  const result = streamPipeline(chunks);
  assert.ok(!result.includes("function"), `function key leaked`);
  assert.ok(!result.includes("ls"), `command leaked`);
});

// ── TEST 15: Only text, no tool calls — zero transformations ──────────
test("REAL-15: plain text unchanged by pipeline", () => {
  const chunks = ["Hello ", "world", "!"];
  const result = streamPipeline(chunks);
  assert.strictEqual(result, "Hello world!");
});

// ── TEST 16: Qwen flat-format tool calls (name + fields, no arguments) ──
test("REAL-16: flat-format tool calls extracted, XML wrapping stripped", () => {
  // From logs/2026-06-06_18-18-21.json — Qwen outputs <tool_call> wrapping
  // with {"name":"read","filePath":"..."} instead of nested arguments
  const chunks = [
    '<tool_call>\n{"name',
    '":',
    ' "read", "',
    'filePath',
    '": "/home/y',
    'oussefvdel/',
    'Projects/qwen-st',
    'udio-2.',
    '1.0/ts',
    'config.json"}\n',
    '</tool_call>\n<tool_call>\n',
    '{"name": "',
    'read", "filePath',
    '": "/home/y',
    'oussefvdel/',
    'Projects/qwen-st',
    'udio-2.',
    '1.0/',
    'forge.config.ts"}',
    '\n</tool_call>\n<tool_call>',
    '\n{"name":',
    ' "read", "',
    'filePath": "/home',
    '/youssefvdel',
    '/Projects/qwen',
    '-studio-2',
    '.1.0',
    '/src"}\n</tool_call>',
    '\n<tool_call>\n{"',
    'name": "read',
    '", "filePath":',
    ' "/home/yousse',
    'fvdel/Projects',
    '/qwen-studio',
    '-2.1',
    '.0/qwen',
    '-core"}\n</tool_call>',
  ];
  const result = streamPipeline(chunks);
  // All tool call JSON + XML wrapping should be stripped from text
  assert.ok(!result.includes('"name"'), `Tool names leaked: ${JSON.stringify(result)}`);
  assert.ok(!result.includes('"filePath"'), `filePath leaked`);
  assert.ok(!result.includes('<tool_call'), `<tool_call tag leaked: ${JSON.stringify(result)}`);
  assert.ok(!result.includes('</tool_call'), `</tool_call tag leaked`);
  assert.ok(result.length < 30, `Expected near-empty output, got ${result.length}B: ${JSON.stringify(result)}`);
});

// ── TEST 17: Flat format without XML wrapping, double-brace trailing ──
test("REAL-17: flat-format + double braces stripped from text", () => {
  // From logs/2026-06-06_18-30-32.json — Qwen outputs flat format with
  // text prefix and double }} at end of each tool call
  const chunks = [
    'Let me dig deeper',
    ' into the source code',
    ' and dependencies.\n\n',
    '{"',
    'name": "read',
    '", "',
    'filePath": "/home',
    '/youssefvdel',
    '/Projects/qwen',
    '-studio-2',
    '.1.0',
    '/src"}}\n{"',
    'name": "read',
    '", "filePath":',
    ' "/home/yousse',
    'fvdel/Projects',
    '/qwen-studio',
    '-2.1',
    '.0/qwen',
    '-core"}}\n{"',
    'name": "read',
    '", "filePath":',
    ' "/home/yousse',
    'fvdel/Projects',
    '/qwen-studio',
    '-2.1',
    '.0/tsconfig',
    '.json"}}\n{"',
    'name": "read',
    '", "filePath":',
    ' "/home/yousse',
    'fvdel/Projects',
    '/qwen-studio',
    '-2.1',
    '.0/forge',
    '.config.ts"}}\n',
    '{"name": "',
    'read", "filePath',
    '": "/home/y',
    'oussefvdel/',
    'Projects/qwen-st',
    'udio-2.',
    '1.0/scripts',
    '"}}',
  ];
  const result = streamPipeline(chunks);
  // Text prefix should survive
  assert.ok(result.startsWith("Let me dig deeper"),
    `Text prefix lost: ${JSON.stringify(result)}`);
  // Tool call JSON should be stripped
  assert.ok(!result.includes('"name"'), `Tool names leaked: ${JSON.stringify(result)}`);
  assert.ok(!result.includes('"filePath"'), `filePath leaked`);
  // Extra trailing braces stripped
  assert.ok(!result.includes('}}'), `Double braces leaked: ${JSON.stringify(result)}`);
  assert.ok(result.length < 200,
    `Expected ~80B output, got ${result.length}B: ${JSON.stringify(result)}`);
});

// ── TEST 18: 4 read tool calls consecutively — all stripped from text ──
test("REAL-18: 4 consecutive read tool calls, OpenAI format, stripped cleanly", () => {
  const chunks = [
    '{"name": "read", "arguments": {"filePath": "/home/youssefvdel/Projects/qwen-studio-2.1.0/src/preload/index.ts"}}\n' +
    '{"name": "read", "arguments": {"filePath": "/home/youssefvdel/Projects/qwen-studio-2.1.0/src/main/ipc-handlers.ts"}}\n' +
    '{"name": "read", "arguments": {"filePath": "/home/youssefvdel/Projects/qwen-studio-2.1.0/src/main/window-manager.ts"}}\n' +
    '{"name": "read", "arguments": {"filePath": "/home/youssefvdel/Projects/qwen-studio-2.1.0/src/main/mcp-config.ts"}}',
  ];
  const result = streamPipeline(chunks);
  // All 4 tool calls should be stripped
  assert.ok(!result.includes('"name"'), `Tool name leaked: ${JSON.stringify(result)}`);
  assert.ok(!result.includes('"arguments"'), `arguments key leaked: ${JSON.stringify(result)}`);
  assert.ok(!result.includes('"filePath"'), `filePath leaked: ${JSON.stringify(result)}`);
  // No text fragments should survive (pure tool calls)
  assert.strictEqual(result.replace(/\n/g, '').trim(), '',
    `Pure tool calls should produce empty text, got: ${JSON.stringify(result)}`);
});

// ── TEST 19: Echo detection trigger — text before echo survives ─────
test("REAL-19: echo detection trigger does not corrupt preceding text", () => {
  const text = '### Security Analysis Report\n\nThe following vulnerabilities were identified in the specified files. Each includes the exact file path, line numbers, risk description, and a concrete code fix.\n\n---\n\n#### 1. Unvalidated `shell.openExternal` in IPC Handler\n- **File**: `src/main/ipc-handlers.ts`\n- **Lines**: 69-75\n- **Risk**: The `open_external_link` handler accepts a `url` string directly from the renderer and passes it to `shell.openExternal` without validation.';
  const expectedOutput = text;
  const result = streamPipeline([text]);
  // No content should be stripped (it's plain text, no tool calls)
  assert.strictEqual(result, expectedOutput,
    `Plain text should survive pipeline unchanged.\n  expected: ${JSON.stringify(expectedOutput.substring(0, 100))}\n  got:      ${JSON.stringify(result.substring(0, 100))}`);
  assert.ok(result.length > 300,
    `Output too short: ${result.length}B`);
});
