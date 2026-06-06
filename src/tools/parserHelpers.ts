import { v4 as uuidv4 } from 'uuid';
import type { ParsedToolCall } from './types.ts';
import { robustParseJSON } from '../utils/json.ts';

export function processCharAt(buf: string, i: number): { newIndex: number; inString: boolean; foundEnd: boolean } {
  const c = buf[i];
  if (c === '\\') {
    i++;
    if (i >= buf.length) return { newIndex: i, inString: true, foundEnd: true };
    if (buf[i] === 'u') {
      if (i + 4 >= buf.length) return { newIndex: i, inString: true, foundEnd: true };
      i += 4;
    }
    return { newIndex: i, inString: true, foundEnd: false };
  }
  if (c === '"') return { newIndex: i, inString: false, foundEnd: false };
  return { newIndex: i, inString: true, foundEnd: false };
}

export function trackDepth(c: string, depth: number): { depth: number; inString: boolean; atRoot: boolean } {
  switch (c) {
    case '"': return { depth, inString: true, atRoot: false };
    case '{': case '[': return { depth: depth + 1, inString: false, atRoot: false };
    case '}': case ']': {
      const newDepth = depth - 1;
      return { depth: newDepth, inString: false, atRoot: newDepth === 0 };
    }
    default: return { depth, inString: false, atRoot: false };
  }
}

export function findJsonEnd(buf: string): number {
  let i = 0;
  while (i < buf.length && ' \t\n\r'.includes(buf[i])) i++;
  if (i >= buf.length) return -1;
  const startChar = buf[i];
  if (startChar !== '{' && startChar !== '[') return -1;
  let depth = 0;
  let inString = false;
  for (; i < buf.length; i++) {
    const c = buf[i];
    if (inString) {
      const result = processCharAt(buf, i);
      i = result.newIndex;
      inString = result.inString;
      if (result.foundEnd) return -1;
      continue;
    }
    const result = trackDepth(c, depth);
    depth = result.depth;
    inString = result.inString;
    if (result.atRoot) return i + 1;
  }
  return -1;
}

export function normalizeJsonNewlines(raw: string): string {
  let result = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (c === '\\') { result += c; i++; if (i < raw.length) result += raw[i]; continue; }
      if (c === '"') { inString = false; result += c; continue; }
      if (c === '\n' || c === '\r' || c === '\t') { continue; }
      result += c;
    } else {
      if (c === '"') inString = true;
      result += c;
    }
  }
  return result;
}

export function looksLikeToolCall(jsonStr: string): boolean {
  const norm = jsonStr.replace(/\s+/g, '');
  return norm.includes('"name"') && (
    norm.includes('"arguments"') ||
    norm.includes('"function"') ||
    norm.includes('"parameters"')
  );
}

export function parseToolCall(parsed: Record<string, unknown>): ParsedToolCall | null {
  let name = parsed.name;
  let args = parsed.arguments ?? parsed.parameters;
  if (!name && parsed.function && typeof parsed.function === 'object') {
    const fn = parsed.function as Record<string, unknown>;
    name = fn.name;
    args = args ?? fn.arguments ?? fn.parameters;
  }
  if (!name || typeof name !== 'string') return null;
  const trimmedName = name.trim();
  if (!trimmedName) return null;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    if (args === undefined || args === null) {
      const { name: _n, function: _f, ...rest } = parsed;
      args = Object.keys(rest).length > 0 ? rest : {};
    } else { args = {}; }
  }
  return { id: `call_${crypto.randomUUID()}`, name: trimmedName, arguments: args as Record<string, unknown> };
}

export function compactBuffer(buffer: string, textEmissionBoundary: number, offset: number): { buffer: string; textEmissionBoundary: number } {
  const MAX_BUFFER_SIZE = 65536;
  const TRIM_KEEP_CONTEXT = 4096;
  let newBuffer = buffer;
  let newBoundary = textEmissionBoundary;
  if (newBoundary > MAX_BUFFER_SIZE) {
    const trimPoint = newBoundary - TRIM_KEEP_CONTEXT;
    newBuffer = newBuffer.substring(trimPoint);
    const trimDelta = trimPoint;
    newBoundary = TRIM_KEEP_CONTEXT;
    offset -= trimDelta;
  }
  if (offset > 0 && offset < newBuffer.length) {
    newBuffer = newBuffer.substring(offset);
    newBoundary -= offset;
    if (newBoundary < 0) newBoundary = 0;
  } else if (offset >= newBuffer.length) {
    newBuffer = '';
    newBoundary = 0;
  }
  return { buffer: newBuffer, textEmissionBoundary: newBoundary };
}

export interface ExtractResult {
  textContent: string;
  toolCall: ParsedToolCall | null;
  remaining: string;
  shouldBreak: boolean;
}

export function findBalancedJsonEnd(s: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

export function tryExtractToolCall(remaining: string): ExtractResult {
  const nameIdx = remaining.indexOf('"name"');
  if (nameIdx === -1) {
    return { textContent: remaining, toolCall: null, remaining: '', shouldBreak: true };
  }
  const searchFrom = Math.max(0, nameIdx - 300);
  const braceIdx = remaining.lastIndexOf('{', nameIdx);
  if (braceIdx === -1 || braceIdx < searchFrom) {
    return { textContent: remaining[0] || '', toolCall: null, remaining: remaining.substring(1), shouldBreak: false };
  }
  const textContent = braceIdx > 0 ? remaining.substring(0, braceIdx) : '';
  const after = remaining.substring(braceIdx);
  const jsonEnd = findBalancedJsonEnd(after);
  if (jsonEnd === -1) {
    return { textContent: remaining, toolCall: null, remaining: '', shouldBreak: true };
  }
  const jsonStr = after.substring(0, jsonEnd);
  try {
    const parsed = robustParseJSON(jsonStr);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON');
    let args = parsed.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (typeof args !== 'object' || Array.isArray(args)) args = {};
    const toolCall: ParsedToolCall = {
      id: 'call_' + uuidv4(),
      name: parsed.name || '',
      arguments: args || (() => { const { name: _name, ...rest } = parsed; return rest; })(),
    };
    return { textContent, toolCall, remaining: after.substring(jsonEnd), shouldBreak: false };
  } catch {
    return { textContent: jsonStr, toolCall: null, remaining: after.substring(jsonEnd), shouldBreak: false };
  }
}
