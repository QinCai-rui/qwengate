import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { validateSingleToolCall } from "../tools/guard.ts";
import { logStore } from "../services/logStore.ts";

// ── Debug / Logging utilities ─────────────────────────────────────

export function logDebug(label: string, data: any) {
  if (false) return;
  const _prefix = `[DEBUG ${new Date().toISOString()}]`;
  if (typeof data === "string") {
    const _truncated =
      data.length > 5000
        ? data.substring(0, 5000) +
          `\n... [truncated ${data.length - 5000} more chars]`
        : data;
  } else {
    const json = JSON.stringify(data, null, 2);
    const _truncated =
      json.length > 5000
        ? json.substring(0, 5000) +
          `\n... [truncated ${json.length - 5000} more chars]`
        : json;
  }
}

const STREAM_DEBUG_FILE = join(
  process.cwd(),
  "output-bugs",
  "log",
  "stream-debug.log",
);
let _streamDebugDirReady = false;
export function streamDebugLog(
  _sessionId: string,
  stage: string,
  data: string | Record<string, unknown>,
) {
  if (false) return;
  if (stage !== "RAW_CHUNK") return;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  try {
    if (!_streamDebugDirReady) {
      const dir = dirname(STREAM_DEBUG_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      _streamDebugDirReady = true;
    }
    appendFileSync(STREAM_DEBUG_FILE, `${payload}\n`);
  } catch (_e) {
    /* debug logging is best-effort */
  }
}

export function safeTruncate(val: any, maxLen = 200): any {
  if (typeof val === "string") {
    if (val.length > maxLen) return val.substring(0, maxLen) + "...";
    return val;
  }
  if (Array.isArray(val)) return val.map((v) => safeTruncate(v, maxLen));
  if (val && typeof val === "object") {
    const obj: any = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = safeTruncate(v, maxLen);
    }
    return obj;
  }
  return val;
}

// ── String / diff utilities ───────────────────────────────────────

export function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

export function getNewContent(text: string, lastEmittedText: string): string {
  if (!text) return "";
  const commonLen = commonPrefixLen(text, lastEmittedText);
  if (commonLen < text.length) return text.substring(commonLen);
  return "";
}

export function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

export function detectCumulativeChunk(
  newText: string,
  lastText: string,
): { cumulative: boolean; delta: string } {
  if (!lastText || !newText) return { cumulative: false, delta: newText };
  if (newText === lastText) return { cumulative: false, delta: "" };

  if (newText.startsWith(lastText) && newText.length > lastText.length) {
    return { cumulative: true, delta: newText.substring(lastText.length) };
  }

  if (newText.length > lastText.length && lastText.length >= 32) {
    const fingerprint = lastText.slice(-Math.min(64, lastText.length));
    const idx = newText.indexOf(fingerprint);
    if (idx !== -1) {
      const expectedEnd = idx + lastText.length;
      if (expectedEnd <= newText.length) {
        const candidateRegion = newText.substring(idx, idx + lastText.length);
        const suffixMatch = commonSuffixLen(candidateRegion, lastText);
        if (suffixMatch >= Math.min(lastText.length * 0.9, lastText.length - 4)) {
          const delta = newText.substring(expectedEnd);
          return { cumulative: true, delta };
        }
      }
    }
  }
  return { cumulative: false, delta: newText };
}

export function getSnapshotDelta(
  newSnapshot: string,
  lastSnapshot: string,
): string {
  if (!newSnapshot) return "";
  if (!lastSnapshot) return newSnapshot;
  if (newSnapshot === lastSnapshot) return "";
  if (newSnapshot.length <= lastSnapshot.length) return "";
  if (newSnapshot.startsWith(lastSnapshot)) return newSnapshot.substring(lastSnapshot.length);
  const detection = detectCumulativeChunk(newSnapshot, lastSnapshot);
  if (detection.cumulative) return detection.delta;
  return "";
}

export function cleanThinkTags(t: string): string {
  let s = t.replace(/<\/?(?:think|thinking|thought|tool_call|tool_use|function_call|tool)>/gi, "");
  s = s.replace(/<\/tool(?:_result)?/gi, "");
  return s;
}

export function truncateToolResult(
  content: string,
  maxBytes: number = 4096,
): string {
  if (!content) return "";
  const encoded = new TextEncoder().encode(content);
  if (encoded.length <= maxBytes) return content;

  const headBytes = Math.floor(maxBytes * 0.45);
  const tailBytes = Math.floor(maxBytes * 0.45);

  const headView = new Uint8Array(encoded.buffer, 0, headBytes);
  const head = new TextDecoder("utf-8", { fatal: false }).decode(headView);
  const tailStart = encoded.length - tailBytes;
  const tailView = new Uint8Array(encoded.buffer, tailStart, tailBytes);
  const tail = new TextDecoder("utf-8", { fatal: false }).decode(tailView);

  return `${head}\n... [truncated ${content.length - headBytes - tailBytes} chars] ...\n${tail}`;
}

/**
 * Smart compression for tool results before they reach the LLM.
 * Prevents echo at the source by compressing structured tool output
 * into a form the model can analyze but cannot verbatim-repeat.
 */
export function compressToolResult(content: string): string {
  if (!content || content.length < 500) return content;

  const lines = content.split('\n');
  const totalLines = lines.length;

  if (content.includes('diff --git') || content.includes('--- a/')) {
    const diffHeaders: string[] = [];
    let totalHunks = 0;
    let totalChangedLines = 0;
    for (const line of lines) {
      if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@ ')) {
        diffHeaders.push(line);
        if (line.startsWith('@@ ')) totalHunks++;
      }
      if (line.startsWith('+') || line.startsWith('-')) totalChangedLines++;
    }
    if (diffHeaders.length > 0) {
      return `<compressed diff>\nFiles changed annotations (${diffHeaders.filter(l => l.startsWith('diff')).length} files, ${totalHunks} hunks, ${totalChangedLines} lines changed):\n\n${diffHeaders.join('\n')}\n\n[Content compressed — ${totalLines} lines reduced to ${diffHeaders.length + 5} lines summary]\n</compressed diff>`;
    }
  }

  const trimmed = content.trim();
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    let parsed: any;
    try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
    if (parsed !== null) {
      if (Array.isArray(parsed)) {
        const sample = parsed.slice(0, 3);
        const remaining = parsed.length - 3;
        return remaining > 0
          ? `${JSON.stringify(sample, null, 2)}\n... [${remaining} more items omitted — ${parsed.length} total] ...`
          : trimmed;
      }
      if (trimmed.length < 3000) return trimmed;
    }
  }

  const linePattern = lines[0]?.match(/^([\w./-]+):\d+/);
  if (linePattern || lines.every(l => l.startsWith('./') || l.startsWith('/'))) {
    const uniqueDirs = new Set(lines.map(l => l.substring(0, l.lastIndexOf('/') + 1)).filter(Boolean));
    const summary = `<compressed listing>\n${totalLines} entries across ${uniqueDirs.size} directories\nSample (first 10):\n${lines.slice(0, 10).join('\n')}\n${totalLines > 10 ? `\n... [${totalLines - 10} more entries omitted] ...` : ''}\n</compressed listing>`;
    return summary.length < content.length * 0.7 ? summary : content;
  }

  if (content.includes('test ') && (lines.some(l => /^test\s+\S+.*\s(ok|FAILED)\s/.test(l)) || content.includes('test result:'))) {
    let passed = 0;
    let failed = 0;
    const failureContext: string[] = [];
    let inFailure = false;
    let failCountdown = 0;
    for (const line of lines) {
      const testMatch = line.match(/^test\s+(\S+).*\s(ok|FAILED)\s/);
      if (testMatch) {
        if (testMatch[2] === 'ok') passed++;
        else { failed++; failureContext.push(line); inFailure = true; failCountdown = 15; }
      } else if (inFailure && failCountdown > 0) { failureContext.push(line); failCountdown--; if (failCountdown === 0) inFailure = false; }
    }
    const resultLine = lines.find(l => l.includes('test result:'));
    const body = `${resultLine || `cargo test: ${passed} passed, ${failed} failed`}${failed > 0 ? `\n\nFailure details:\n${failureContext.join('\n')}` : ''}`;
    const compressed = `<compressed cargo test>\n${body}\n[${totalLines} lines → ${(body.match(/\n/g) || []).length + 4} lines]\n</compressed cargo test>`;
    if (compressed.length < content.length * 0.7) return compressed;
  }

  if (lines.some(l => /(PASSED|FAILED|ERROR)\s*$/.test(l.trim()))) {
    let passed = 0, failed = 0, errors = 0;
    const failureContext: string[] = [];
    let inFailure = false, failCountdown = 0;
    for (const line of lines) {
      const t = line.trim();
      if (/PASSED\s*$/.test(t) && !t.includes('==')) passed++;
      else if (/FAILED\s*$/.test(t) && !t.includes('==')) { failed++; failureContext.push(line); inFailure = true; failCountdown = 20; }
      else if (/ERROR\s*$/.test(t) && !t.includes('==')) { errors++; failureContext.push(line); inFailure = true; failCountdown = 20; }
      else if (inFailure && failCountdown > 0) { failureContext.push(line); failCountdown--; if (failCountdown === 0) inFailure = false; }
    }
    if (passed + failed + errors > 0) {
      const body = `pytest: ${passed} passed, ${failed} failed${errors > 0 ? `, ${errors} errors` : ''}${failureContext.length > 0 ? `\n\nFailures:\n${failureContext.join('\n')}` : ''}`;
      const compressed = `<compressed pytest>\n${body}\n[${totalLines} lines → ${(body.match(/\n/g) || []).length + 4} lines]\n</compressed pytest>`;
      if (compressed.length < content.length * 0.7) return compressed;
    }
  }

  if (totalLines > 3 && (lines.some(l => /^CONTAINER\s+ID\s/.test(l)) || lines.some(l => /^REPOSITORY\s+TAG\s/.test(l)))) {
    const h = lines[0];
    const sampleRows = lines.slice(1, 4).filter(l => l.trim());
    const dataRows = lines.slice(1).filter(l => l.trim()).length;
    const remaining = dataRows - sampleRows.length;
    const body = `${h}\n${sampleRows.length > 0 ? sampleRows.join('\n') : '(empty)'}${remaining > 0 ? `\n\n... [${remaining} more rows omitted — ${dataRows} total entries] ...` : ''}`;
    const compressed = `<compressed docker>\n${body}\n[${totalLines} lines → ${(body.match(/\n/g) || []).length + 4} lines]\n</compressed docker>`;
    if (compressed.length < content.length * 0.7) return compressed;
  }

  if (lines.some(l => /npm (ERR|WARN)/.test(l)) || lines.some(l => /^\s*\+?\s*[\w.-]+@/.test(l) && l.includes('added'))) {
    const npmErrors = lines.filter(l => /npm ERR/i.test(l));
    const warnings = [...new Set(lines.filter(l => /npm WARN/i.test(l)))];
    const summaryLines = lines.filter(l => /^\s*(up to date|packages are looking|\d+ packages are|\d+ vulnerabilities?)/i.test(l));
    const auditLines = lines.filter(l => /^\s*(added|removed|changed|found|\d+)/i.test(l) && /\b(audit|package|vulnerabilit)/i.test(l));
    const parts: string[] = [];
    if (auditLines.length > 0) parts.push(auditLines.join('\n'));
    if (summaryLines.length > 0) parts.push(summaryLines.join('\n'));
    if (warnings.length > 0) parts.push(`Warnings (${warnings.length} unique):\n${warnings.join('\n')}`);
    if (npmErrors.length > 0) parts.push(`Errors:\n${npmErrors.join('\n')}`);
    const body = parts.join('\n');
    const compressed = `<compressed npm>\n${body}\n[${totalLines} lines → ${(body.match(/\n/g) || []).length + 4} lines]\n</compressed npm>`;
    if (compressed.length < content.length * 0.7) return compressed;
  }

  if (lines.some(l => /^[0-9a-f]{7,40}\s{2,}/.test(l)) && totalLines > 5) {
    const entries: string[] = [];
    for (const line of lines) {
      const match = line.match(/^([0-9a-f]{7,40})\s+(.*)/);
      if (match) entries.push(`${match[1].substring(0, 7)} ${match[2].trim() || '(no message)'}`);
    }
    if (entries.length > 0) {
      const compressed = `<compressed git log>\n${entries.join('\n')}\n[${totalLines} lines → ${entries.length} commits]\n</compressed git log>`;
      if (compressed.length < content.length * 0.7) return compressed;
    }
  }

  if (/(Changes not staged for commit|Untracked files|Changes to be committed)/.test(content)) {
    const sections: { name: string; files: string[] }[] = [];
    let cur: { name: string; files: string[] } | null = null;
    for (const line of lines) {
      const headerMatch = line.match(/^#?\s*(Changes (not staged for commit|to be committed)|Untracked files):/);
      if (headerMatch) { cur = { name: headerMatch[1], files: [] }; sections.push(cur); }
      else if (cur && /^\s+\S/.test(line) && line.trim()) cur.files.push(line.trim());
    }
    if (sections.length > 0) {
      const parts = sections.map(s => `${s.name}: ${s.files.length} files`);
      const compressed = `<compressed git status>\n${parts.join('\n')}\n[${totalLines} lines → ${sections.length + 4} lines]\n</compressed git status>`;
      if (compressed.length < content.length * 0.7) return compressed;
    }
  }

  if (lines.some(l => l.includes('->')) && lines.some(l => /^\s*To\s/.test(l))) {
    const refLines = lines.filter(l => l.includes('->') && !l.includes('* ') && !l.includes('Already'));
    const compressed = `<compressed git push>\nPushed ${refLines.length} ref(s):\n${refLines.join('\n')}\n[${totalLines} lines → ${refLines.length + 4} lines]\n</compressed git push>`;
    if (compressed.length < content.length * 0.7) return compressed;
  }

  if (totalLines > 50 && !trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    const first20 = lines.slice(0, 20);
    const last10 = lines.slice(-10);
    const omitted = totalLines - 30;
    const compressed = `${first20.join('\n')}\n... [${omitted} lines omitted] ...\n${last10.join('\n')}`;
    if (compressed.length < content.length * 0.7) return compressed;
  }

  return truncateToolResult(content);
}

// ── Tool and streaming utilities ──────────────────────────────────

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
    if (typeof args !== "object" || args === null) return args;
    if (Array.isArray(args)) return args.map((a) => this.canonicalize(a));
    return Object.keys(args).sort().reduce((acc: any, key) => {
      acc[key] = this.canonicalize(args[key]);
      return acc;
    }, {});
  }

  check(tool: string, args: any): { ok: true } | { ok: false; correctionPrompt: string } {
    const key = `${tool}:${JSON.stringify(this.canonicalize(args))}`;
    const recent = this.history.slice(-this.window);
    const count = recent.filter((h) => h.key === key).length + 1;
    this.history.push({ key });
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

export const pendingCorrections = new Map<string, string[]>();

export function parseQwenErrorPayload(
  raw: string,
): { message: string; status: import("hono/utils/http-status").ContentfulStatusCode } | null {
  const text = raw.trim();
  if (!text || text.startsWith("data: ")) return null;
  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || "UpstreamError";
      const details = payload.data?.details || payload.message || "Qwen returned an error";
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : "";
      const status = code === "RateLimited" ? 429 : code === "Not_Found" ? 404 : 502;
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === "string" ? payload.error : payload.error.message || JSON.stringify(payload.error);
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }
  return null;
}

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
  let vStr = "";
  let foundStr = false;
  let isThinkingChunk = false;
  let newThoughtIndex = currentThoughtIndex;

  if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && (targetResponseId === null || chunk.response_id === targetResponseId)) {
    const delta = chunk.choices[0].delta;
    if (delta.phase === "thinking_summary") {
      isThinkingChunk = true;
      if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
        const thoughts = delta.extra.summary_thought.content;
        const rawNew = thoughts.slice(currentThoughtIndex).join("\n");
        if (rawNew) {
          const commonLen = commonPrefixLen(rawNew, reasoningBuffer);
          vStr = rawNew.substring(commonLen);
          if (vStr) { newThoughtIndex = thoughts.length; foundStr = true; }
        }
      }
    } else if (delta.phase === "answer") {
      isThinkingChunk = false;
      if (delta.content !== undefined) {
        vStr = delta.content || "";
        if (vStr) foundStr = true;
      }
    }
  }
  return { vStr, foundStr, isThinkingChunk, currentThoughtIndex: newThoughtIndex };
}

export interface ToolCallProcessingOptions {
  label?: string;
  logParsed?: boolean;
  logId: string;
  toolSpamGuard: ToolSpamGuard;
  correctionPrompts: string[];
  maxToolCalls: number;
}

export function processToolCallsThroughGuard(
  toolCalls: any[],
  toolCallsOut: any[],
  options: ToolCallProcessingOptions,
): void {
  const { label, logParsed = false, logId, toolSpamGuard, correctionPrompts, maxToolCalls } = options;
  for (const tc of toolCalls) {
    const guard = validateSingleToolCall(tc);
    if (!guard.ok) {
      correctionPrompts.push(guard.correctionPrompt);
      continue;
    }
    const spamCheck = toolSpamGuard.check(tc.name, tc.arguments);
    if (!spamCheck.ok) {
      console.warn(`  [🛑 TOOL SPAM${label ? " " + label : ""}] ${tc.name}: repeated call blocked`);
      correctionPrompts.push(spamCheck.correctionPrompt);
      continue;
    }
    if (toolCallsOut.length >= maxToolCalls) {
      console.warn(`  [🛑 TOOL LIMIT${label ? " " + label : ""}] Hit ${maxToolCalls} tool calls per turn, dropping excess`);
      correctionPrompts.push(`[TOOL CALL LIMIT] Reached maximum of ${maxToolCalls} tool calls per turn. Analyze existing results and respond to the user.`);
      break;
    }
    toolCallsOut.push({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    });
    if (logParsed) {
      logStore.updateEntry(logId, (entry: any) => {
        entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
      });
    }
  }
}

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
      logStore.recordAmplificationEvent(logId, ratio, lastRawContent || lastVStrRaw || "");
    }
  }
  return state.triggered;
}
