import assert from 'node:assert';
import test from 'node:test';
import { buildQwenMessages, detachOlderContext } from './chatHelpers.ts';

function featureConfigFor(body: Record<string, unknown>): Record<string, unknown> {
  const result = buildQwenMessages([{ role: 'user', content: 'hello' }], body, false);
  return result.qwenMessages[0].feature_config;
}

test('OpenAI fast modes disable Qwen thinking', () => {
  const fast = featureConfigFor({ model: 'qwen3.6-plus', reasoning: { effort: 'fast' } });
  const none = featureConfigFor({ model: 'qwen3.6-plus', reasoning: { effort: 'none' } });
  assert.strictEqual(fast.thinking_enabled, false);
  assert.strictEqual(fast.thinking_mode, 'Fast');
  assert.strictEqual(none.thinking_enabled, false);
});

test('OpenAI Qwen thinking modes are forwarded', () => {
  const thinking = featureConfigFor({ model: 'qwen3.6-plus', reasoning: { effort: 'thinking' } });
  const auto = featureConfigFor({ model: 'qwen3.6-plus', reasoning_effort: 'auto' });
  assert.strictEqual(thinking.thinking_enabled, true);
  assert.strictEqual(thinking.auto_thinking, false);
  assert.strictEqual(thinking.thinking_mode, 'Thinking');
  assert.strictEqual(auto.thinking_enabled, true);
  assert.strictEqual(auto.auto_thinking, true);
  assert.strictEqual(auto.thinking_mode, 'Auto');
});

test('OpenAI explicit thinking options are supported', () => {
  assert.strictEqual(featureConfigFor({ model: 'qwen3.6-plus', enable_thinking: false }).thinking_enabled, false);
  assert.strictEqual(featureConfigFor({ model: 'qwen3.6-plus', extra_body: { enable_thinking: false } }).thinking_enabled, false);
});

test('no-thinking model suffix still disables thinking', () => {
  assert.strictEqual(featureConfigFor({ model: 'qwen3.6-plus-no-thinking' }).thinking_enabled, false);
});

test('system instructions are kept inline to avoid a file-upload round trip', () => {
  const result = buildQwenMessages(
    [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hello' },
    ],
    { model: 'qwen3.7-plus' },
    false,
  );

  assert.match(String(result.qwenMessages[0].content), /<system-instructions>\nBe concise\.\n<\/system-instructions>/);
  assert.strictEqual(result.systemContent, 'Be concise.');
});

test('all request context remains inline without a Qwen file attachment', () => {
  const history = 'x'.repeat(60_000);
  const result = buildQwenMessages(
    [
      { role: 'user', content: history },
      { role: 'assistant', content: 'Previous answer.' },
      { role: 'tool', name: 'read', content: 'tool output' },
      { role: 'user', content: 'Continue.' },
    ],
    { model: 'qwen3.7-plus' },
    false,
  );

  const prompt = String(result.qwenMessages[0].content);
  assert.ok(prompt.includes(history));
  assert.match(prompt, /<tool-result tool="read">\ntool output\n<\/tool-result>/);
  assert.ok(!prompt.includes('[TRUNCATED:'));
  assert.deepStrictEqual(result.qwenMessages[0].files, []);
});

test('older history is detached before the inline request reaches Qwen WAF size', () => {
  const olderTurn = 'a'.repeat(90_000);
  const currentTurn = 'b'.repeat(30_000);
  const result = buildQwenMessages(
    [
      { role: 'system', content: 'Follow instructions.' },
      { role: 'user', content: olderTurn },
      { role: 'assistant', content: 'Earlier response.' },
      { role: 'user', content: currentTurn },
    ],
    { model: 'qwen3.7-plus' },
    false,
  );

  const detachedHistory = detachOlderContext(result.qwenMessages);
  const inlineContent = String(result.qwenMessages[0].content);
  assert.ok(detachedHistory?.includes(olderTurn));
  assert.ok(!inlineContent.includes(olderTurn));
  assert.ok(inlineContent.includes(currentTurn));
  assert.match(inlineContent, /<system-instructions>\nFollow instructions\.\n<\/system-instructions>/);
  assert.match(
    inlineContent,
    /<conversation-history-file>Earlier conversation history is attached in context\.txt\.<\/conversation-history-file>/,
  );
  assert.ok(inlineContent.length <= 100_000);
});
