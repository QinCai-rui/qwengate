import assert from 'node:assert';
import test from 'node:test';
import { parseQwenErrorPayload } from './chatHelpersCore.ts';
import { processStreamData, type StreamProcessingState } from './chatStreamingHelpers.ts';

function streamState(): StreamProcessingState {
  return {
    targetResponseId: null,
    nextParentId: null,
    completionTokens: 0,
    promptTokens: 0,
    currentThoughtIndex: -1,
    reasoningBuffer: '',
    lastFullContent: '',
    lastRawContent: '',
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    pendingChunk: '',
  };
}

test('Qwen CAPTCHA JSON is surfaced as an upstream error', () => {
  const result = parseQwenErrorPayload(JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::request rejected'] }));
  assert.deepStrictEqual(result, {
    message: 'Qwen upstream error: FAIL_SYS_USER_VALIDATE: RGV587_ERROR::SM::request rejected',
    status: 502,
  });
});

test('stream processing stops on a plain JSON Qwen rejection', async () => {
  const state = streamState();
  const result = await processStreamData({ ret: ['FAIL_SYS_USER_VALIDATE', 'request rejected'] }, state, {
    streamWriter: {},
    completionId: 'test',
    model: 'qwen3.7-plus',
    emittedToolCallCount: 0,
    enableContentFiltering: true,
    cleanOutput: true,
    logId: 'test',
    resolvedEmail: 'test@example.com',
    ampState: { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false },
    qwenAbortController: new AbortController(),
  });

  assert.strictEqual(result, 'break_stream');
  assert.strictEqual(state.upstreamError, 'Qwen upstream error: FAIL_SYS_USER_VALIDATE: request rejected');
});
