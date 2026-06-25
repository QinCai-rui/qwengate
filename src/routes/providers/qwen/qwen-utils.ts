/*
 * File: providers/qwen/qwen-utils.ts
 * Qwen-specific utility functions extracted from chatHelpersCore.ts.
 * These are only used by the Qwen provider pipeline, not by other providers.
 */

import { logStore } from '../../../services/logStore.ts';
import { validateSingleToolCall } from '../../../tools/guard.ts';
import { TOOL_CALL_KEYWORDS, TOOL_RESULT_KEYWORDS } from '../../../utils/tagNames.ts';
import { QWEN_THINK_TAG_PATTERN as THINK_TAG_PATTERN } from '../../../utils/thinkTagStripper.ts';
import { commonPrefixLen, commonSuffixLen, detectCumulativeChunk } from '../../chatHelpersCore.ts';

export function getSnapshotDelta(newSnapshot: string, lastSnapshot: string): string {
  if (!newSnapshot) return '';
  if (!lastSnapshot) return newSnapshot;
  if (newSnapshot === lastSnapshot) return '';

  if (newSnapshot.length > lastSnapshot.length && newSnapshot.startsWith(lastSnapshot)) return newSnapshot.substring(lastSnapshot.length);

  const prefixLen = commonPrefixLen(newSnapshot, lastSnapshot);
  if (prefixLen > 0 && prefixLen < newSnapshot.length) {
    return newSnapshot.substring(prefixLen);
  }
  if (prefixLen === newSnapshot.length && prefixLen > 0) {
    return '';
  }

  const detection = detectCumulativeChunk(newSnapshot, lastSnapshot);
  if (detection.cumulative) return detection.delta;
  return '';
}

// ── Tool call XML tag stripping ───────────────────────────────────

const TOOL_RESULT_TAG_PATTERN = new RegExp(`<\\/${TOOL_RESULT_KEYWORDS.join('|')}>`, 'gi');

const MIN_TOOL_PREFIX_LEN = 3;
const [TOOL_TAG_RE] = (() => {
  const keywords = TOOL_CALL_KEYWORDS;
  const tagPrefixes: string[] = [];

  for (const kw of keywords) {
    for (let i = MIN_TOOL_PREFIX_LEN; i <= kw.length; i++) {
      const p = kw.slice(0, i);
      tagPrefixes.push(p);
      tagPrefixes.push('/' + p);
    }
  }

  tagPrefixes.sort((a, b) => b.length - a.length);
  const tagRe = new RegExp(`<(?:${tagPrefixes.join('|')})[^>]*(?:>|$)`, 'gi');
  return [tagRe];
})();

export function cleanThinkTags(t: string): string {
  if (!t.includes('<') && !t.includes('=') && !t.includes('>')) return t;
  let s = t.replace(THINK_TAG_PATTERN, '');
  s = s.replace(TOOL_RESULT_TAG_PATTERN, '');
  s = s.replace(TOOL_TAG_RE, '');
  s = s.replace(/^=[^\s>]+>/gm, '');
  s = s.replace(/^[a-z]+=[^\s>]+>/gm, '');
  s = s.replace(/^[a-z]{3,}>/gm, '');
  s = s.replace(/<\/(?=$)/g, '');
  s = s.replace(/<$/g, '');
  return s;
}

// ── Tool spam guard ───────────────────────────────────────────────

export class ToolSpamGuard {
  private window: number;
  private threshold: number;
  private history: Array<{ key: string }>;

  constructor(window = 8, threshold = 2) {
    this.window = window;
    this.threshold = threshold;
    this.history = [];
  }

  private canonicalize(args: any): any {
    if (typeof args !== 'object' || args === null) return args;
    if (Array.isArray(args)) return args.map((a) => this.canonicalize(a));
    return Object.keys(args)
      .sort()
      .reduce((acc: any, key) => {
        acc[key] = this.canonicalize(args[key]);
        return acc;
      }, {});
  }

  check(tool: string, args: any): { ok: true } | { ok: false; correctionPrompt: string } {
    const key = `${tool}:${JSON.stringify(this.canonicalize(args))}`;
    const recent = this.history.slice(-this.window);
    const count = recent.filter((h) => h.key === key).length + 1;
    this.history.push({ key });
    if (this.history.length > this.window * 2) this.history = this.history.slice(-this.window);
    if (count > this.threshold) {
      return {
        ok: false,
        correctionPrompt:
          `[TOOL SPAM] Called "${tool}" with identical arguments ${count} times in the last ${this.window} calls. ` +
          `Stop repeating this call. Analyze the results you already have and respond to the user. ` +
          `Do NOT call "${tool}" again with the same arguments.`,
      };
    }
    return { ok: true };
  }
}

// ── Qwen error parsing ────────────────────────────────────────────

export function parseQwenErrorPayload(
  raw: string,
): { message: string; status: import('hono/utils/http-status').ContentfulStatusCode } | null {
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith('data: ')) text = text.slice(6).trim();
  if (text === '[DONE]' || text.startsWith(':')) return null;
  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : code === 'Not_Found' ? 404 : 502;
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : payload.error.message || JSON.stringify(payload.error);
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    return null;
  }
  return null;
}

// ── Tool call guard processing ────────────────────────────────────

export interface ToolCallProcessingOptions {
  label?: string;
  logParsed?: boolean;
  logId: string;
  toolSpamGuard: ToolSpamGuard;
  correctionPrompts: string[];
  maxToolCalls: number;
}

export function processToolCallsThroughGuard(toolCalls: any[], toolCallsOut: any[], options: ToolCallProcessingOptions): void {
  const { label, logParsed = false, logId, toolSpamGuard, correctionPrompts, maxToolCalls } = options;
  const effectiveMax = maxToolCalls ?? 8;

  if (toolCalls.length > effectiveMax) {
    logStore.log(
      'debug',
      'chat',
      `  [TOOL LIMIT${label ? ' ' + label : ''}] Truncating ${toolCalls.length} tool calls to first ${effectiveMax}`,
    );
    toolCalls = toolCalls.slice(0, effectiveMax);
  }

  for (const tc of toolCalls) {
    const guard = validateSingleToolCall(tc);
    if (!guard.ok) {
      correctionPrompts.push(guard.correctionPrompt);
      continue;
    }
    const spamCheck = toolSpamGuard.check(tc.name, tc.arguments);
    if (!spamCheck.ok) {
      logStore.log('debug', 'chat', `  [TOOL SPAM${label ? ' ' + label : ''}] ${tc.name}: repeated call blocked`);
      correctionPrompts.push(spamCheck.correctionPrompt);
      continue;
    }
    if (toolCallsOut.length >= maxToolCalls) {
      logStore.log('debug', 'chat', `  [TOOL LIMIT${label ? ' ' + label : ''}] Hit ${maxToolCalls} tool calls per turn, dropping excess`);
      correctionPrompts.push(
        `[TOOL CALL LIMIT] Reached maximum of ${maxToolCalls} tool calls per turn. Analyze existing results and respond to the user.`,
      );
      break;
    }
    toolCallsOut.push({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    });
    if (logParsed) {
      logStore.updateEntry(logId, (entry: any) => {
        entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
      });
    }
  }
}

// ── Amplification guard ───────────────────────────────────────────

export interface AmplificationGuardState {
  rawInputBytes: number;
  emittedOutputBytes: number;
  triggered: boolean;
}

export function checkAmplificationGuard(
  state: AmplificationGuardState,
  newOutputLen: number,
  logId: string,
  resolvedEmail: string,
  model: string,
  lastRawContent: string,
  lastVStrRaw: string,
): boolean {
  if (!state.triggered) {
    const projectedRatio = (state.emittedOutputBytes + newOutputLen) / Math.max(1, state.rawInputBytes);
    if (projectedRatio > 3 && state.emittedOutputBytes > 1000) {
      state.triggered = true;
      const ratio = Math.round(projectedRatio * 100) / 100;
      console.error(
        `[Chat][AMPLIFICATION GUARD] Triggered! ratio=${ratio}x rawIn=${state.rawInputBytes}B emittedOut=${state.emittedOutputBytes}B account=${resolvedEmail} model=${model}`,
      );
      logStore.recordAmplificationEvent(logId, ratio, lastRawContent || lastVStrRaw || '');
    }
  }
  return state.triggered;
}

// ── Delta content extraction ───────────────────────────────────────

export interface DeltaContentResult {
  vStr: string;
  foundStr: boolean;
  isThinkingChunk: boolean;
  currentThoughtIndex: number;
}

export function extractDeltaContent(
  chunk: any,
  targetResponseId: string | null,
  currentThoughtIndex: number,
  reasoningBuffer: string,
): DeltaContentResult {
  let vStr = '';
  let foundStr = false;
  let isThinkingChunk = false;
  let newThoughtIndex = currentThoughtIndex;

  if (
    chunk.choices &&
    chunk.choices[0] &&
    chunk.choices[0].delta &&
    (targetResponseId === null || chunk.response_id === targetResponseId || chunk['response.created']?.response_id === targetResponseId)
  ) {
    const delta = chunk.choices[0].delta;
    if (delta.phase === 'thinking_summary') {
      isThinkingChunk = true;
      if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
        const thoughts = delta.extra.summary_thought.content;
        const rawNew = thoughts.slice(currentThoughtIndex).join('\n');
        if (rawNew) {
          const commonLen = commonPrefixLen(rawNew, reasoningBuffer);
          vStr = rawNew.substring(commonLen);
          if (vStr) {
            newThoughtIndex = thoughts.length;
            foundStr = true;
          }
        }
      }
    } else if (delta.phase === 'think') {
      isThinkingChunk = true;
      if (delta.content !== undefined) {
        vStr = delta.content || '';
        if (vStr) foundStr = true;
      }
    } else if (delta.phase === 'answer') {
      isThinkingChunk = false;
      if (delta.content !== undefined) {
        vStr = delta.content || '';
        if (vStr) foundStr = true;
      }
    } else if (delta.reasoning_content !== undefined && delta.reasoning_content) {
      // OpenAI-compatible format (no phase field): reasoning_content for thinking
      isThinkingChunk = true;
      vStr = delta.reasoning_content;
      if (vStr) foundStr = true;
    } else if (delta.content !== undefined && delta.content && !delta.phase) {
      // OpenAI-compatible format (no phase field): content for answer
      isThinkingChunk = false;
      vStr = delta.content;
      if (vStr) foundStr = true;
    }
  }
  return { vStr, foundStr, isThinkingChunk, currentThoughtIndex: newThoughtIndex };
}

// ── Cleanup helpers ────────────────────────────────────────────────

/**
 * Check amplification ratio and warn / log if it exceeds threshold.
 */
export function checkFinalAmplification(
  ampState: AmplificationGuardState,
  logId: string,
  resolvedEmail: string,
  logStoreUpdater: { updateEntry: (id: string, fn: (e: any) => void) => void },
) {
  const finalRatio = ampState.rawInputBytes > 0 ? Math.round((ampState.emittedOutputBytes / ampState.rawInputBytes) * 100) / 100 : 0;
  if (finalRatio > 2) {
    logStore.log(
      'debug',
      'chat',
      `[Chat] High amplification ratio: ${finalRatio}x ` +
        `(rawIn=${ampState.rawInputBytes}B, out=${ampState.emittedOutputBytes}B) account=${resolvedEmail}`,
    );
    logStoreUpdater.updateEntry(logId, (entry: any) => {
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
    release: (chatId: string, parentId: string | null, headers: any, email: string, isSuccess?: boolean) => void;
  },
  isSuccess: boolean = true,
): () => void {
  let cancelled = false;
  setTimeout(() => {
    if (cancelled) return;
    clearInterval(heartbeatInterval);
    try {
      reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      reader?.releaseLock();
    } catch {
      /* ignore */
    }
    sessionPool.release(chatId, parentId, headers, email, isSuccess);
  }, 0);
  return () => {
    cancelled = true;
  };
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
    release: (chatId: string, parentId: string | null, headers: any, email: string, isSuccess?: boolean) => void;
  },
  isSuccess: boolean = true,
) {
  clearInterval(heartbeatInterval);
  if (streamReader) {
    try {
      streamReader.cancel();
    } catch {
      /* ignore */
    }
    try {
      streamReader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  sessionPool.release(chatId, parentId, headers, email, isSuccess);
}
