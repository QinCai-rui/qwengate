import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedToolCall } from '../types/openai.ts';
import type { QwenPayload } from './qwen.ts';
import { projectPath } from '../utils/paths.ts';

const LOG_DIR = projectPath('logs', 'qwen');

interface WriteEntry {
  filepath: string;
  data: string;
}

let writeQueue: WriteEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function ensureDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function enqueueWrite(filepath: string, data: string): void {
  writeQueue.push({ filepath, data });
  if (!flushTimer) {
    flushTimer = setTimeout(flushQueue, 500);
  }
}

function flushQueue(): void {
  flushTimer = null;
  const batch = writeQueue;
  writeQueue = [];
  for (const entry of batch) {
    writeFileSync(entry.filepath, entry.data);
  }
}

export function logQwenRequest(
  payload: QwenPayload,
  _url: string,
): string {
  ensureDir();
  const timestamp = Date.now();
  const d = new Date(timestamp);
  const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const timeStr = `${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}-${String(d.getSeconds()).padStart(2,'0')}-${String(d.getMilliseconds()).padStart(3,'0')}`;
  const chatId = payload.chat_id || 'new';
  const shortChat = chatId.substring(0, 8);
  const filename = `${dateStr}_${timeStr}_${shortChat}_request.json`;
  const filepath = join(LOG_DIR, filename);
  enqueueWrite(filepath, JSON.stringify(payload, null, 2));
  return filepath;
}

export function logQwenResponse(
  requestFile: string,
  status: number,
  statusText: string,
  headers: Record<string, string>,
  responsePreview: string,
): void {
  if (!existsSync(requestFile)) return;
  const responseFile = requestFile.replace('_request.json', '_response.json');
  const entry = {
    status,
    statusText,
    headers,
    responsePreview: responsePreview.substring(0, 2000),
    timestamp: Date.now(),
  };
  enqueueWrite(responseFile, JSON.stringify(entry, null, 2));
}

setInterval(() => {
  try {
    const files = readdirSync(LOG_DIR).sort();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of files) {
      const fp = join(LOG_DIR, f);
      const stat = statSync(fp);
      if (stat.mtimeMs < sevenDaysAgo) unlinkSync(fp);
    }
  } catch { /* non-blocking */ }
}, 24 * 60 * 60 * 1000);

export function logQwenSSE(
  logFile: string | undefined,
  sseEvents: number,
  toolCallEvents: number,
  toolCalls: ParsedToolCall[],
): void {
  if (!logFile) return;
  const sseFile = logFile.replace(/\.json$/, '_sse.json');
  const entry = {
    totalEvents: sseEvents,
    toolCallEvents,
    toolCalls,
    timestamp: Date.now(),
  };
  enqueueWrite(sseFile, JSON.stringify(entry, null, 2));
}
