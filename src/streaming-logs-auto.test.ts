import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripStreamingDelta, stripToolCallArtifacts } from './utils/xmlStripper.ts';

// Same pipeline as streaming-real-patterns.test.ts
function streamPipeline(chunks: string[]): string {
  let acc = '';
  for (const c of chunks) {
    acc += stripStreamingDelta(c);
  }
  return stripToolCallArtifacts(acc);
}

const LOGS_DIR = resolve(import.meta.dirname, '../logs');

// Get all log files sorted by name
function getLogFiles(): string[] {
  try {
    const files = readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => resolve(LOGS_DIR, f));
    return files;
  } catch {
    return [];
  }
}

interface LogEntry {
  raw_output: string;
  processed_output: { content: string; tool_calls: unknown[] };
  chunks: string[];
  errors: unknown[];
  finalResponse: { toolCallCount: number; finishReason: string };
  [key: string]: unknown;
}

function loadLog(file: string): LogEntry | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as LogEntry;
  } catch {
    return null;
  }
}

const logFiles = getLogFiles();

describe(`Auto-log tests (${logFiles.length} logs from logs/)`, () => {
  for (const file of logFiles) {
    const basename = file.split('/').pop() || 'unknown';
    const log = loadLog(file);
    if (!log || !log.chunks || log.chunks.length === 0) {
      test(`${basename}: SKIP (no chunks)`, () => {}); // mark as seen
      continue;
    }

    test(`${basename}: no tool call JSON or XML tags leak through pipeline`, () => {
      const result = streamPipeline(log.chunks);
      const errors = log.errors ?? [];
      const failures: string[] = [];

      // 1. Tool call JSON must NOT leak into result
      if (result.includes('"name"') && !log.raw_output?.includes('"name"')) {
        failures.push(`'name' leaked: ${JSON.stringify(result.substring(0, 100))}`);
      } else if (result.includes('"name"')) {
        // raw_output has "name" — only fail if full JSON tool calls survive
        if (result.includes('{"name"') || result.includes('\n{"name"')) {
          failures.push(`Complete tool call JSON leaked: ${JSON.stringify(result.substring(0, 100))}`);
        }
      }

      // 2. XML tags must NOT survive in output
      if (result.includes('<tool_call') || result.includes('</tool_call>')) {
        failures.push(`tool_call XML tag leaked: ${JSON.stringify(result.substring(0, 100))}`);
      }
      if (result.includes('<tool_result') || result.includes('</tool_result>')) {
        failures.push(`tool_result XML tag leaked: ${JSON.stringify(result.substring(0, 100))}`);
      }
      if (result.includes('<invoke') || result.includes('</invoke>')) {
        failures.push(`invoke XML tag leaked: ${JSON.stringify(result.substring(0, 100))}`);
      }

      // 3. No dangling JSON artifacts
      const trimmed = result.trim();
      if (trimmed.startsWith('",') || trimmed.startsWith('}') || trimmed.startsWith('{')) {
        // Only flag if it starts with JSON artifact AND raw had tool calls
        if (log.raw_output?.includes('"name"')) {
          failures.push(`Result starts with JSON artifact: ${JSON.stringify(trimmed.substring(0, 40))}`);
        }
      }

      if (failures.length > 0) {
        assert.fail(
          `${basename}: ${failures.length} leak(s)\n` +
          failures.join('\n') +
          `\n  raw_len=${log.raw_output?.length ?? 0} result_len=${result.length} errors=${errors.length}`,
        );
      }
    });
  }
});
