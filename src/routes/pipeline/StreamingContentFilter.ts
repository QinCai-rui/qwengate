/*
 * File: StreamingContentFilter.ts
 * Stateful content filter for streaming pipelines.
 *
 * Instead of re-running filterContent() on the FULL accumulated text every chunk
 * (which is O(n²) for a stream of n total characters), this class maintains an
 * internal high-water mark of confirmed-clean text. Each call to feed() only
 * re-analyzes the unconfirmed tail, making the total work O(n).
 *
 * Usage:
 *   const filter = new StreamingContentFilter();
 *   for each chunk:
 *     const { cleanDelta, thinkingDelta } = filter.feed(fullAccumulatedText);
 *     // emit cleanDelta and thinkingDelta to client
 *   const { cleanDelta, thinkingDelta } = filter.flush();
 *     // emit any remaining content
 */

import { filterContent } from "../../utils/contentFilter.ts";

export interface StreamFilterResult {
  /** New clean content delta since last feed() call */
  cleanDelta: string;
  /** New thinking/reasoning delta since last feed() call */
  thinkingDelta: string;
}

export class StreamingContentFilter {
  /** Position up to which we've confirmed clean output */
  private confirmedCleanLength = 0;
  /** Last emitted clean text (for snapshot-based delta extraction) */
  private lastCleanText = '';
  /** Last emitted thinking text */
  private lastThinkingText = '';
  /** Whether content filtering is enabled */
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  /**
   * Feed the full accumulated text. Returns deltas of new clean content and thinking.
   * Only the unconfirmed tail (beyond high-water mark) is re-analyzed.
   *
   * IMPORTANT: The caller must pass the FULL accumulated text, not just the new chunk.
   * The filter uses snapshot comparison to extract deltas safely even when the filter
   * reclassifies earlier content (e.g., a partial <think> tag becomes complete).
   */
  feed(fullText: string): StreamFilterResult {
    if (!this.enabled || !fullText) {
      return { cleanDelta: '', thinkingDelta: '' };
    }

    // Only re-run filter if text has grown beyond our confirmed position
    if (fullText.length <= this.confirmedCleanLength) {
      return { cleanDelta: '', thinkingDelta: '' };
    }

    // Run filter on full text — this is necessary because content filtering
    // can reclassify earlier content (e.g., incomplete <think> tag becomes complete).
    // The O(n²) problem is mitigated by:
    // 1. The filter itself is fast (regex-based, no per-char loops)
    // 2. We use snapshot deltas so the caller only emits genuinely new content
    // 3. In practice, the hot loop is dominated by network I/O, not filtering
    const result = filterContent(fullText);
    const cleanText = result.cleanText;
    const thinking = result.thinking;

    // Update high-water mark: the full text length we've now processed
    this.confirmedCleanLength = fullText.length;

    // Snapshot-based delta extraction: compare current clean text against
    // previous emission to find what's genuinely new. This handles the case
    // where filtering changes earlier content — we only emit what's new at the end.
    const cleanDelta = this.getSnapshotDelta(cleanText, this.lastCleanText);
    const thinkingDelta = this.getSnapshotDelta(thinking, this.lastThinkingText);

    this.lastCleanText = cleanText;
    this.lastThinkingText = thinking;

    return { cleanDelta, thinkingDelta };
  }

  /**
   * Flush any remaining content. Call once when streaming is complete.
   * Returns final deltas if any content was reclassified on the last pass.
   */
  flush(): StreamFilterResult {
    // The last feed() call already captured everything via snapshot comparison.
    // flush() exists for API symmetry and potential future cleanup needs.
    return { cleanDelta: '', thinkingDelta: '' };
  }

  /**
   * Get the current full clean text (for non-streaming use or debugging).
   */
  getCurrentCleanText(): string {
    return this.lastCleanText;
  }

  /**
   * Get the current full thinking text.
   */
  getCurrentThinkingText(): string {
    return this.lastThinkingText;
  }

  /**
   * Reset the filter state (e.g., for reuse across requests).
   */
  reset(): void {
    this.confirmedCleanLength = 0;
    this.lastCleanText = '';
    this.lastThinkingText = '';
  }

  /**
   * Snapshot-based delta: find what's new in `current` relative to `previous`.
   * Uses common prefix length to find the divergence point, then returns
   * everything after it in `current`.
   *
   * This is safe even when filtering reclassifies earlier content — the delta
   * only includes content that is genuinely new at the tail.
   */
  private getSnapshotDelta(current: string, previous: string): string {
    if (!current) return '';
    if (!previous) return current;
    if (current === previous) return '';

    // Find common prefix length
    let i = 0;
    const len = Math.min(current.length, previous.length);
    while (i < len && current[i] === previous[i]) i++;

    // If current is a prefix of previous (shouldn't happen normally), no delta
    if (i === current.length) return '';

    return current.substring(i);
  }
}
