/**
 * Regression: tool_result with ARRAY content (Claude Code format) must not be
 * dropped by anthropicMessagesToOpenAI — previously became '' → Qwen re-emitted
 * the same tool call forever (agent loop until max turns).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { anthropicMessagesToOpenAI } = await import('../routes/anthropic.ts');

test('tool_result array content is flattened, not dropped', () => {
  const messages = [
    { role: 'user', content: 'Write agent-claude.txt' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'Write', input: { file_path: 'agent-claude.txt', content: 'hello' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: [
            { type: 'text', text: 'File written successfully' },
            { type: 'text', text: '3 lines written' },
          ],
        },
      ],
    },
  ];

  const converted = anthropicMessagesToOpenAI(messages as any);
  const toolMsg = converted.find((m: any) => m.role === 'tool');
  console.log('converted tool message:', JSON.stringify(toolMsg));
  assert.ok(toolMsg, 'tool message must exist');
  assert.ok(toolMsg.content.includes('File written successfully'), 'text block content must survive');
  assert.ok(toolMsg.content.includes('3 lines written'), 'second block must survive');
  console.log('✅ tool_result array content flattened correctly');
});

test('tool_result string content still passes through', () => {
  const messages = [
    { role: 'user', content: 'Read x' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: 'x' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'file contents here' }] },
  ];
  const converted = anthropicMessagesToOpenAI(messages as any);
  const toolMsg = converted.find((m: any) => m.role === 'tool');
  assert.equal(toolMsg.content, 'file contents here');
});
