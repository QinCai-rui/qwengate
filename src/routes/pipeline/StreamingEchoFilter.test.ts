/*
 * File: StreamingEchoFilter.test.ts
 * Tests for the streaming-native echo filter with hold-back buffer.
 * Uses node:test runner (tsx --test).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { StreamingEchoFilter } from './StreamingEchoFilter.ts';

// Use the same env-var defaults as StreamingEchoFilter.ts
const JACCARD_THRESHOLD = parseFloat(process.env.ECHO_JACCARD_THRESHOLD || '0.9');
const MIN_LINE_LENGTH = parseInt(process.env.ECHO_MIN_LINE_LENGTH || '20', 10);
const MIN_UNIQUE_SHINGLES = parseInt(process.env.ECHO_MIN_UNIQUE_SHINGLES || '8', 10);

describe('StreamingEchoFilter', () => {
  const TOOL_RESULTS = [
    'CPU usage is at 45% capacity\nMemory: 2.1GB total\nDisk: 78% used',
    'function hello() {\n  console.log("world");\n}',
    'Error: File not found at /path/to/file.txt\nStack trace:\n  at line 42',
  ];

  describe('constructor', () => {
    it('should accept empty tool results array', () => {
      const filter = new StreamingEchoFilter([]);
      assert.ok(filter !== undefined);
    });

    it('should accept multiple tool results', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      assert.ok(filter !== undefined);
    });
  });

  describe('feed - no echo', () => {
    it('should return cleanDelta for original content with newline', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      const result = filter.feed('Original content here\n');
      assert.equal(result.cleanDelta, 'Original content here\n');
      assert.equal(result.echoDetected, false);
    });

    it('should hold partial line (no newline)', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      const result = filter.feed('Partial line without newline');
      assert.equal(result.cleanDelta, '');
      assert.equal(result.echoDetected, false);
    });

    it('should emit held content when newline arrives', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      const r1 = filter.feed('Partial line');
      assert.equal(r1.cleanDelta, '');
      const r2 = filter.feed('Partial line without newline\n');
      assert.equal(r2.cleanDelta, 'Partial line without newline\n');
      assert.equal(r2.echoDetected, false);
    });

    it('should return empty delta for identical content re-fed', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      const r1 = filter.feed('Original content here\n');
      assert.equal(r1.cleanDelta, 'Original content here\n');
      const r2 = filter.feed('Original content here\n');
      assert.equal(r2.cleanDelta, '');
    });

    it('should handle multiple lines across chunks', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      const r1 = filter.feed('Line 1\nLine 2\n');
      assert.equal(r1.cleanDelta, 'Line 1\nLine 2\n');
      assert.equal(r1.echoDetected, false);
    });
  });

  describe('feed - echo detected', () => {
    it('should detect verbatim echo', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      const result = filter.feed('CPU usage is at 45% capacity\n');
      assert.equal(result.echoDetected, true);
      assert.ok(result.similarity >= JACCARD_THRESHOLD);
      assert.ok(result.cleanDelta === '');
    });

    it('should detect echo on second line', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      const result = filter.feed('Clean line here with enough chars\nCPU usage is at 45% capacity\n');
      assert.equal(result.echoDetected, true);
      assert.ok(result.similarity >= JACCARD_THRESHOLD);
    });

    it('should NOT emit cleanDelta on echo', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      const result = filter.feed('Clean line here with enough chars\nCPU usage is at 45% capacity\n');
      assert.equal(result.cleanDelta, '');
    });

    it('should detect echo spanning chunks', () => {
      const filter = new StreamingEchoFilter(['Memory: 2.1GB']);
      const r1 = filter.feed('Memory: 2.');
      assert.equal(r1.echoDetected, false);
      assert.equal(r1.cleanDelta, '');
      const r2 = filter.feed('Memory: 2.1GB\n');
      assert.equal(r2.echoDetected, true);
      assert.ok(r2.similarity >= JACCARD_THRESHOLD);
    });

    it('should detect Unicode echo', () => {
      const filter = new StreamingEchoFilter(['错误: 文件未找到 at path /usr/local']);
      const result = filter.feed('错误: 文件未找到 at path /usr/local\n');
      assert.equal(result.echoDetected, true);
      assert.ok(result.similarity >= JACCARD_THRESHOLD);
    });
  });

  describe('feed - short lines', () => {
    it('should skip lines < 10 chars after normalization', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      const result = filter.feed('ab\nCPU usage is at 45% capacity\n');
      assert.equal(result.echoDetected, true);
    });

    it('should emit short lines that are not echoes', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      const result = filter.feed('ab\nOriginal content here with enough chars\n');
      assert.equal(result.cleanDelta, 'ab\nOriginal content here with enough chars\n');
      assert.equal(result.echoDetected, false);
    });
  });

  describe('feed - similarity tracking', () => {
    it('should report max similarity', () => {
      const filter = new StreamingEchoFilter(['The file contains 42 lines of code.']);
      const result = filter.feed('The file contains 42 lines of code\n');
      assert.equal(result.echoDetected, true);
      assert.ok(result.similarity > 0);
    });

    it('should report 0 similarity for completely different content', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      const result = filter.feed('Completely unrelated content here with enough chars\n');
      assert.equal(result.similarity, 0);
    });
  });

  describe('flush', () => {
    it('should return remaining content', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      filter.feed('confirmed\n');
      const remaining = filter.flush('confirmed\nremaining text');
      assert.equal(remaining, 'remaining text');
    });

    it('should return empty when nothing held', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      filter.feed('all confirmed\n');
      const remaining = filter.flush('all confirmed\n');
      assert.equal(remaining, '');
    });

    it('should return empty for empty text', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      const remaining = filter.flush('');
      assert.equal(remaining, '');
    });
  });

  describe('reset', () => {
    it('should clear state for reuse', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      filter.feed('CPU usage is at 45% capacity\n');
      filter.reset();
      const result = filter.feed('CPU usage is at 45% capacity\n');
      assert.equal(result.cleanDelta, '');
      assert.equal(result.echoDetected, true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty fullText', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      const result = filter.feed('');
      assert.equal(result.cleanDelta, '');
      assert.equal(result.echoDetected, false);
    });

    it('should handle tool results with only whitespace', () => {
      const filter = new StreamingEchoFilter(['   \n  \n   ']);
      const result = filter.feed('Some content\n');
      assert.equal(result.cleanDelta, 'Some content\n');
      assert.equal(result.echoDetected, false);
    });

    it('should handle very long lines', () => {
      const longLine = 'x'.repeat(10000);
      const filter = new StreamingEchoFilter([longLine]);
      const result = filter.feed(longLine + '\n');
      assert.equal(result.echoDetected, true);
    });

    it('should handle multiple newlines in chunk', () => {
      const filter = new StreamingEchoFilter(TOOL_RESULTS);
      const result = filter.feed('Line 1\n\n\nLine 2\n');
      assert.equal(result.cleanDelta, 'Line 1\n\n\nLine 2\n');
      assert.equal(result.echoDetected, false);
    });
  });

  describe('bidirectional containment', () => {
    it('should NOT flag lines that share shingles one-way (output→tool) but not tool→output', () => {
      const filter = new StreamingEchoFilter(['Error: File not found at /path/to/file.txt']);
      // A line that references the tool result structure but is mostly the model's own analysis
      const result = filter.feed('File not found at the specified path. Please check the location.\n');
      assert.equal(result.echoDetected, false);
      assert.equal(result.cleanDelta, 'File not found at the specified path. Please check the location.\n');
    });

    it('should NOT flag lines with generic words that happen to appear in tool results', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity\nMemory: 2.1GB total\nDisk: 78% used']);
      const result = filter.feed('Current memory usage is approximately 2GB which looks normal.\n');
      assert.equal(result.echoDetected, false);
    });
  });

  describe('canary token detection', () => {
    it('should detect when model echoes a canary token', () => {
      const filter = new StreamingEchoFilter(['[tc-a1b2c3d4] some tool result content here with enough chars']);
      const result = filter.feed('Let me tell you about [tc-a1b2c3d4] some tool result content here with enough chars\n');
      assert.equal(result.echoDetected, true);
      assert.equal(result.similarity, 1.0);
      assert.ok(result.reason.includes('canary'));
    });

    it('should NOT detect when model describes tool result without canary', () => {
      const filter = new StreamingEchoFilter(['[tc-a1b2c3d4] File not found at path /usr/local']);
      const result = filter.feed('The file was not found at the specified path.\n');
      assert.equal(result.echoDetected, false);
    });
  });

  describe('chunk boundary scenarios', () => {
    it('should handle echo split across multiple chunks', () => {
      const filter = new StreamingEchoFilter(['Memory usage is at 2.1GB total']);
      const r1 = filter.feed('Memory usage is at ');
      assert.equal(r1.echoDetected, false);
      const r2 = filter.feed('Memory usage is at 2.');
      assert.equal(r2.echoDetected, false);
      const r3 = filter.feed('Memory usage is at 2.1GB total\n');
      assert.equal(r3.echoDetected, true);
    });

    it('should emit clean content before echo', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      const r1 = filter.feed('First line ok with enough chars\n');
      assert.equal(r1.cleanDelta, 'First line ok with enough chars\n');
      assert.equal(r1.echoDetected, false);
      const r2 = filter.feed('First line ok with enough chars\nCPU usage is at 45% capacity\n');
      assert.equal(r2.echoDetected, true);
      assert.equal(r2.cleanDelta, '');
    });

    it('should handle mixed clean and echo lines', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      const r1 = filter.feed('System resources look healthy and normal\nCPU usage is at 45% capacity\n');
      assert.equal(r1.echoDetected, true);
      assert.equal(r1.cleanDelta, '');
    });
  });

  describe('false positive prevention', () => {
    it('should NOT flag brief references to tool results', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity']);
      const result = filter.feed('CPU usage is at 45% which is normal and healthy.\n');
      assert.equal(result.echoDetected, false);
      assert.equal(result.cleanDelta, 'CPU usage is at 45% which is normal and healthy.\n');
    });

    it('should NOT flag analysis of tool results', () => {
      const filter = new StreamingEchoFilter(['CPU usage is at 45% capacity\nMemory: 2.1GB total']);
      const result = filter.feed('System resources are within normal limits and healthy.\n');
      assert.equal(result.echoDetected, false);
    });

    it('should NOT flag original content with similar words', () => {
      const filter = new StreamingEchoFilter(['The file contains 42 lines of code.']);
      const result = filter.feed('This is a completely different sentence with 42 words total.\n');
      assert.equal(result.echoDetected, false);
    });
  });
});
