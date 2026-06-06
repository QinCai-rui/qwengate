import {
  pendingCorrections,
  detectCumulativeChunk,
  getSnapshotDelta,
  cleanThinkTags,
  extractDeltaContent,
  streamDebugLog,
  logDebug,
  type AmplificationGuardState,
} from './chatHelpers.ts';
import { validateSingleToolCall } from '../tools/guard.ts';
import { logStore } from '../services/logStore.ts';
import { filterContent, stripToolCallArtifacts, stripStreamingDelta } from '../utils/contentFilter.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { StreamingContentFilter } from './pipeline/StreamingContentFilter.ts';
import { StreamingEchoFilter } from './pipeline/StreamingEchoFilter.ts';
import {
  writeReasoningEvent,
  writeContentDelta,
  writeToolCallEvent,
  writeDeferredThinking,
} from './writeHelpers.ts';

// ── Tool call handling ─────────────────────────────────────────────

/**
 * Log tool calls to logStore, validate each, and write SSE events.
 * Returns true if all tool calls passed validation.
 */
export async function handleToolCalls(
  toolCalls: any[],
  logId: string,
  streamWriter: any,
  completionId: string,
  model: string,
  toolParser: { getEmittedToolCallCount: () => number },
): Promise<boolean> {
  logStore.updateEntry(logId, entry => {
    for (const tc of toolCalls) {
      entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
    }
  });

  let allValid = true;
  const baseIndex = toolParser.getEmittedToolCallCount() - toolCalls.length;
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const guard = validateSingleToolCall(tc);
    if (!guard.ok) {
      allValid = false;
      logStore.updateEntry(logId, entry => {
        entry.errors.push(`Guard rejected streaming tool call "${tc.name}": ${guard.errors.join(', ')}`);
      });
      continue;
    }
    await writeToolCallEvent(streamWriter, completionId, model, tc, baseIndex + i);
  }
  return allValid;
}

// ── Echo detection handling ────────────────────────────────────────

/**
 * Handle echo detection: cancel streams, log error, set corrections.
 */
export async function handleEchoDetection(
  echoResult: { echoDetected: boolean; reason: string; similarity: number; matchedLine?: string },
  reader: ReadableStreamDefaultReader<Uint8Array>,
  streamReader: ReadableStreamDefaultReader<Uint8Array> | null,
  qwenAbortController: AbortController,
  streamWriter: { writer?: { abort: (err: Error) => void } },
  logId: string,
  resolvedEmail: string,
): Promise<void> {
  console.warn(`[StreamingEchoFilter] ${echoResult.reason}`);
  logStore.updateEntry(logId, entry => {
    entry.level = 'error';
    entry.errors.push(`[Echo Detection] ${echoResult.reason} | Matched: "${(echoResult.matchedLine || '').substring(0, 120)}"`);
  });

  reader.cancel();
  if (streamReader) streamReader.cancel();
  qwenAbortController.abort();

  const correction = `[ECHO DETECTED — PREVENT RECURRENCE] You repeated a tool result verbatim (${(echoResult.similarity * 100).toFixed(0)}% match). This is not allowed. Analyze the result internally, then respond to the user in your own words — never copy tool output directly into your response.`;
  pendingCorrections.set('__echo_retry__', [
    ...(pendingCorrections.get('__echo_retry__') || []),
    correction,
  ]);
  pendingCorrections.set(resolvedEmail, [
    ...(pendingCorrections.get(resolvedEmail) || []),
    correction,
  ]);

  try { streamWriter.writer?.abort(new Error('connection lost')); } catch { /* ignore */ }
}

// ── Per-chunk stream processing ────────────────────────────────────

export interface StreamProcessingState {
  targetResponseId: string | null;
  nextParentId: string | null;
  completionTokens: number;
  promptTokens: number;
  currentThoughtIndex: number;
  reasoningBuffer: string;
  deferredThinkingChunks: string[];
  lastFullContent: string;
  lastRawContent: string;
  lastFilteredSnapshot: string;
  lastThinkingSnapshot: string;
  lastVStrRaw: string;
}

export interface StreamProcessingCtx {
  streamWriter: any;
  completionId: string;
  model: string;
  toolParser: StreamingToolParser;
  streamFilter: StreamingContentFilter;
  streamingEchoFilter: StreamingEchoFilter;
  enableContentFiltering: boolean;
  cleanOutput: boolean;
  logId: string;
  resolvedEmail: string;
  ampState: AmplificationGuardState;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  streamReader: ReadableStreamDefaultReader<Uint8Array> | null;
  qwenAbortController: AbortController;
}

export type ProcessStreamResult = 'continue' | 'break_stream' | 'abort_stream';

/**
 * Process a single parsed SSE data chunk from the stream.
 * Mutates `state` in place and returns a directive:
 *   - 'continue'     → normal processing, keep iterating
 *   - 'break_stream' → stream finished (break out of loops)
 *   - 'abort_stream' → echo detected (abort entire stream callback)
 */
export async function processStreamData(
  data: any,
  state: StreamProcessingState,
  ctx: StreamProcessingCtx,
): Promise<ProcessStreamResult> {
  const {
    streamWriter, completionId, model, toolParser, streamFilter,
    streamingEchoFilter, enableContentFiltering, cleanOutput: _cleanOutput,
    logId, resolvedEmail, ampState, reader, streamReader, qwenAbortController,
  } = ctx;

  if (data.choices?.[0]?.delta?.status === 'finished') {
    const deltaPhase = data.choices[0].delta.phase;
    if (deltaPhase !== 'thinking_summary') {
      return 'break_stream';
    }
  }

  if (data['response.created']?.response_id) {
    if (!state.targetResponseId) state.targetResponseId = data['response.created'].response_id;
    state.nextParentId = data['response.created'].response_id;
  } else if (data.response_id && !state.targetResponseId) {
    state.targetResponseId = data.response_id;
    state.nextParentId = data.response_id;
  }

  if (data.usage) {
    if (data.usage.output_tokens) state.completionTokens = data.usage.output_tokens;
    if (data.usage.input_tokens) state.promptTokens = data.usage.input_tokens;
  }

  const deltaResult = extractDeltaContent(data, state.targetResponseId, state.currentThoughtIndex, state.reasoningBuffer);
  const { vStr, foundStr, isThinkingChunk } = deltaResult;
  state.currentThoughtIndex = deltaResult.currentThoughtIndex;

  if (!foundStr || vStr === '') return 'continue';
  if (vStr === 'FINISHED') return 'continue';

  if (isThinkingChunk) {
    state.reasoningBuffer += vStr;
    state.deferredThinkingChunks.push(vStr);
    return 'continue';
  }

  if (/^[\n\s]*<\/?(?:think|thinking|thought|tool_call|tool_use|function_call)[\s>]*[\n\s]*$/.test(vStr)) {
    return 'continue';
  }

  logStore.addRawChunk(logId, vStr);
  streamDebugLog(completionId, 'RAW_CHUNK', vStr);
  if (vStr.includes('"name"')) logDebug('QWEN RAW CHUNK (streaming)', vStr);

  let feedStr = vStr;
  if (state.lastVStrRaw.length > 0) {
    const cumulativeDetection = detectCumulativeChunk(vStr, state.lastVStrRaw);
    streamDebugLog(completionId, 'CUMULATIVE_DETECT', {
      cumulative: cumulativeDetection.cumulative,
      deltaLen: cumulativeDetection.delta.length,
      lastLen: state.lastVStrRaw.length,
      newLen: vStr.length,
    });
    if (cumulativeDetection.cumulative) {
      feedStr = cumulativeDetection.delta;
      state.lastVStrRaw = vStr;
    } else if (!cumulativeDetection.delta) {
      feedStr = '';
    } else {
      state.lastVStrRaw += vStr;
    }
  } else {
    state.lastVStrRaw = vStr;
  }

  const { text: rawText, toolCalls, thinking: parserThinking } = feedStr
    ? toolParser.feed(feedStr)
    : { text: '', toolCalls: [], thinking: '' };
  streamDebugLog(completionId, 'PARSER_OUTPUT', {
    feedLen: feedStr.length,
    textLen: rawText.length,
    toolCount: toolCalls.length,
    toolNames: toolCalls.map(t => t.name),
  });

  if (rawText) {
    streamDebugLog(completionId, 'RAW_TEXT', { len: rawText.length, preview: rawText.substring(0, 100) });
    if (state.lastRawContent.length > 0) {
      const textDetection = detectCumulativeChunk(rawText, state.lastRawContent);
      streamDebugLog(completionId, 'RAW_CUMULATIVE_DETECT', {
        cumulative: textDetection.cumulative,
        deltaLen: textDetection.delta.length,
      });
      if (textDetection.cumulative) {
        state.lastRawContent = rawText;
        state.lastFullContent += textDetection.delta;
      } else if (textDetection.delta) {
        state.lastRawContent += rawText;
        state.lastFullContent += rawText;
      }
    } else {
      state.lastRawContent = rawText;
      state.lastFullContent = rawText;
    }
  }

  streamFilter.feed(state.lastFullContent);
  const baseFilteredContent = enableContentFiltering
    ? filterContent(state.lastFullContent).cleanText
    : state.lastFullContent;
  const filteredThinking = enableContentFiltering
    ? filterContent(state.lastFullContent).thinking
    : '';
  const fullFilteredText = stripToolCallArtifacts(baseFilteredContent);

  const echoResult = streamingEchoFilter.feed(fullFilteredText);
  if (echoResult.echoDetected) {
    await handleEchoDetection(echoResult, reader, streamReader, qwenAbortController, streamWriter, logId, resolvedEmail);
    return 'abort_stream';
  }

  if (state.deferredThinkingChunks.length > 0) {
    await writeDeferredThinking(streamWriter, completionId, model, state.deferredThinkingChunks);
    state.deferredThinkingChunks = [];
  }
  const echoFilteredText = fullFilteredText || null;

  if (parserThinking) {
    await writeReasoningEvent(streamWriter, completionId, model, parserThinking);
  }
  if (filteredThinking) {
    const thinkingDelta = getSnapshotDelta(filteredThinking, state.lastThinkingSnapshot);
    state.lastThinkingSnapshot = filteredThinking;
    if (thinkingDelta) {
      await writeReasoningEvent(streamWriter, completionId, model, thinkingDelta);
    }
  }

  const pendingText = (toolCalls.length > 0 && echoFilteredText) ? echoFilteredText : null;
  const cleanedText = pendingText
    ? cleanThinkTags(pendingText)
    : (echoFilteredText ? cleanThinkTags(echoFilteredText) : null);

  if (toolCalls.length > 0) {
    const allToolCallsValid = await handleToolCalls(toolCalls, logId, streamWriter, completionId, model, toolParser);
    if (pendingText && allToolCallsValid && cleanedText) {
      const contentDelta = stripStreamingDelta(getSnapshotDelta(cleanedText, state.lastFilteredSnapshot));
      state.lastFilteredSnapshot = cleanedText;
      if (contentDelta) {
        await writeContentDelta(streamWriter, completionId, model, contentDelta, ampState, logId, resolvedEmail, state.lastRawContent, state.lastVStrRaw, logStore);
      }
    }
  }

  return 'continue';
}

export { checkFinalAmplification, scheduleCleanup, cleanupImmediately } from "./cleanupHelpers.ts";
export { runStreamLoop, handlePostStreamCompletion } from "./streamLoop.ts";
export type { StreamLoopResult } from "./streamLoop.ts";
