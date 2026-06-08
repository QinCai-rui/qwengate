import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';

/**
 * Split text into variable-length word groups to simulate SSE chunk boundaries.
 * Each token includes trailing whitespace so chunks reassemble with correct spacing.
 */
function streamChunks(text: string): string[] {
  const tokens = text.match(/\S+\s*/g) || [];
  const chunks: string[] = [];
  const pattern = [2, 4, 3, 5, 2];
  let i = 0, pi = 0;
  while (i < tokens.length) {
    const size = Math.min(pattern[pi % pattern.length], tokens.length - i);
    chunks.push(tokens.slice(i, i + size).join(''));
    i += size;
    pi++;
  }
  return chunks;
}

/**
 * Feed text chunk-by-chunk to parser, collect all tool calls and text,
 * then flush — simulating real SSE streaming delivery.
 */
function streamThenParse(
  text: string,
  passThrough = false,
): { toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>; text: string } {
  const p = new StreamingToolParser();
  if (passThrough) p.passThrough = true;
  const allToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let allText = '';
  for (const chunk of streamChunks(text)) {
    const r = p.feed(chunk);
    for (const tc of r.toolCalls) {
      allToolCalls.push(tc as { name: string; arguments: Record<string, unknown> });
    }
    allText += r.text;
  }
  const flush = p.flush();
  for (const tc of flush.toolCalls) {
    allToolCalls.push(tc as { name: string; arguments: Record<string, unknown> });
  }
  allText += flush.text;
  return { toolCalls: allToolCalls, text: allText };
}

test('JSON parser: tool call extracted from text', () => {
  const r = streamThenParse('Hello {"name": "read_file", "arguments": {"path": "foo.txt"}} world');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].name, 'read_file');
  assert.strictEqual(r.toolCalls[0].arguments.path, 'foo.txt');
  assert.strictEqual(r.text, 'Hello  world');
});

test('JSON parser: strips markdown fences', () => {
  const r = streamThenParse('Here:\n```json\n{"name": "read_file", "arguments": {"path": "x.txt"}}\n```\n');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].arguments.path, 'x.txt');
  assert.ok(r.text.includes('Here:'));
});

test('JSON parser: multiple tool calls', () => {
  const r = streamThenParse('{"name": "a", "arguments": {}} {"name": "b", "arguments": {}}');
  assert.strictEqual(r.toolCalls.length, 2);
  assert.strictEqual(r.toolCalls[0].name, 'a');
  assert.strictEqual(r.toolCalls[1].name, 'b');
});

test('JSON parser: streaming split', () => {
  const p = new StreamingToolParser();
  const r1 = p.feed('{"name": "read", "arguments": {"path": "');
  const r2 = p.feed('x.txt"}}');
  const r3 = p.flush();
  const all = [...r1.toolCalls, ...r2.toolCalls, ...r3.toolCalls];
  assert.strictEqual(all.length, 1);
  assert.strictEqual((all[0].arguments as Record<string, unknown>).path, 'x.txt');
});

test('JSON parser: text before and after', () => {
  const r = streamThenParse('start {"name": "x", "arguments": {}} end');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.ok(r.text.includes('start '));
  assert.ok(r.text.includes(' end'));
});

test('JSON parser: passThrough mode', () => {
  const p = new StreamingToolParser();
  p.passThrough = true;
  const r = p.feed('{"name": "x", "arguments": {}}');
  assert.strictEqual(r.text, '{"name": "x", "arguments": {}}');
  assert.strictEqual(r.toolCalls.length, 0);
});

test('JSON parser: nested JSON in arguments', () => {
  const r = streamThenParse('{"name": "edit", "arguments": {"old": "foo", "config": {"nested": true}}}');
  assert.strictEqual(r.toolCalls.length, 1);
  const config = r.toolCalls[0].arguments.config as Record<string, unknown>;
  assert.strictEqual(config.nested, true);
});

test('JSON parser: large tool call', () => {
  const items = [];
  for (let i = 0; i < 500; i++) {
    items.push({ content: 'Item ' + i, status: 'pending' });
  }
  const largeJson = JSON.stringify({ name: 'todo_write', arguments: { todos: items } });
  const r = streamThenParse('Start ' + largeJson + ' End');
  assert.strictEqual(r.toolCalls.length, 1);
  const args = r.toolCalls[0].arguments as Record<string, unknown>;
  const todos = args.todos as Array<unknown>;
  assert.strictEqual(todos.length, 500);
  assert.ok(r.text.includes('Start '));
  assert.ok(r.text.includes(' End'));
});
