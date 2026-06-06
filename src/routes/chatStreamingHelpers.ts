import {
  checkAmplificationGuard,
  type AmplificationGuardState,
} from './chatHelpers.ts';

/**
 * Write a single SSE data event to the stream.
 */
export async function writeEvent(streamWriter: any, data: any): Promise<void> {
  await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Create a streaming choice object (OpenAI SSE format).
 */
export function makeChoice(delta: any, finishReason: string | null = null) {
  return {
    index: 0,
    delta,
    logprobs: null,
    finish_reason: finishReason,
  };
}

/**
 * Build the SSE event skeleton shared by every chunk.
 */
export function buildChunkEvent(completionId: string, model: string, choices: any[], extra?: Record<string, unknown>) {
  return {
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: 'fp_qwen_gate',
    service_tier: 'default',
    choices,
    ...extra,
  };
}

/**
 * Create the usage object for the final SSE event.
 */
/**
 * Write a reasoning_content event.
 */
export async function writeReasoningEvent(
  streamWriter: any, completionId: string, model: string, content: string,
) {
  if (!content) return;
  await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ reasoning_content: content })]));
}

/**
 * Write a content delta event with amplification guard and log store update.
 * Returns false if the amplification guard suppressed the event.
 */
export async function writeContentDelta(
  streamWriter: any,
  completionId: string,
  model: string,
  contentDelta: string,
  ampState: AmplificationGuardState,
  logId: string,
  resolvedEmail: string,
  lastRawContent: string,
  lastVStrRaw: string,
  logStore: { addProcessedOutput: (id: string, c: string) => void; updateEntry: (id: string, fn: (e: any) => void) => void },
): Promise<boolean> {
  if (checkAmplificationGuard(ampState, contentDelta.length, logId, resolvedEmail, model, lastRawContent, lastVStrRaw)) {
    return false;
  }
  logStore.addProcessedOutput(logId, contentDelta);
  ampState.emittedOutputBytes += contentDelta.length;
  await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: contentDelta })]));
  return true;
}

/**
 * Write a tool_calls event for a single tool call.
 */
export async function writeToolCallEvent(
  streamWriter: any, completionId: string, model: string, tc: any, index: number,
) {
  await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({
    tool_calls: [{
      index,
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }],
  })]));
}

/**
 * Write a batch of deferred thinking chunks.
 */
export async function writeDeferredThinking(
  streamWriter: any, completionId: string, model: string, chunks: string[],
) {
  for (const chunk of chunks) {
    await writeReasoningEvent(streamWriter, completionId, model, chunk);
  }
}

export function buildUsage(promptTokens: number, completionTokens: number, reasoningBuffer: string) {
  const streamReasoningTokensEstimate = reasoningBuffer ? Math.ceil(reasoningBuffer.length / 4) : 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    completion_tokens_details: { reasoning_tokens: streamReasoningTokensEstimate },
    prompt_tokens_details: { cached_tokens: 0 },
  };
}

/**
 * Check amplification ratio and warn / log if it exceeds threshold.
 */
export function checkFinalAmplification(
  ampState: AmplificationGuardState,
  logId: string,
  resolvedEmail: string,
  logStore: { updateEntry: (id: string, fn: (e: any) => void) => void },
) {
  const finalRatio =
    ampState.rawInputBytes > 0 ? Math.round((ampState.emittedOutputBytes / ampState.rawInputBytes) * 100) / 100 : 0;
  if (finalRatio > 2) {
    console.warn(
      `[Chat] High amplification ratio: ${finalRatio}x ` +
      `(rawIn=${ampState.rawInputBytes}B, out=${ampState.emittedOutputBytes}B) account=${resolvedEmail}`,
    );
    logStore.updateEntry(logId, (entry: any) => {
      entry.amplificationRatio = finalRatio;
    });
  }
}

/**
 * Schedule cleanup of stream reader / session pool in a timeout.
 */
export function scheduleCleanup(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined | null,
  heartbeatInterval: any,
  chatId: string,
  parentId: string | null,
  headers: any,
  email: string,
  sessionPool: {
    release: (chatId: string, parentId: string | null, headers: any, email: string) => void;
  },
): () => void {
  let cancelled = false;
  setTimeout(() => {
    if (cancelled) return;
    clearInterval(heartbeatInterval);
    try { reader?.cancel(); } catch { /* ignore */ }
    try { reader?.releaseLock(); } catch { /* ignore */ }
    sessionPool.release(chatId, parentId, headers, email);
  }, 200);
  return () => { cancelled = true; };
}

/**
 * Clean up reader and session pool immediately (finally-block path).
 */
export function cleanupImmediately(
  streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined | null,
  heartbeatInterval: any,
  chatId: string,
  parentId: string | null,
  headers: any,
  email: string,
  sessionPool: {
    release: (chatId: string, parentId: string | null, headers: any, email: string) => void;
  },
) {
  clearInterval(heartbeatInterval);
  if (streamReader) {
    try { streamReader.cancel(); } catch { /* ignore */ }
    try { streamReader.releaseLock(); } catch { /* ignore */ }
  }
  sessionPool.release(chatId, parentId, headers, email);
}
