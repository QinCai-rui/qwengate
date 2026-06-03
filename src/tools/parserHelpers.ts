import type { ParsedToolCall } from './types.ts';

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
      if (c === '\\') { i++; if (i >= buf.length) return -1; if (buf[i] === 'u') { if (i + 4 >= buf.length) return -1; i += 4; } continue; }
      if (c === '"') { inString = false; }
      continue;
    }
    switch (c) {
      case '"': inString = true; break;
      case '{': case '[': depth++; break;
      case '}': case ']': depth--; if (depth === 0) return i + 1; break;
    }
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
