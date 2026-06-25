// ── String / diff utilities ───────────────────────────────────────

export function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

export function getNewContent(text: string, lastEmittedText: string): string {
  if (!text) return '';
  const commonLen = commonPrefixLen(text, lastEmittedText);
  if (commonLen < text.length) return text.substring(commonLen);
  return '';
}

export function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

export function detectCumulativeChunk(newText: string, lastText: string): { cumulative: boolean; delta: string } {
  if (!lastText || !newText) return { cumulative: false, delta: newText };
  if (newText === lastText) return { cumulative: false, delta: '' };
  if (newText.startsWith(lastText) && newText.length > lastText.length) {
    return { cumulative: true, delta: newText.substring(lastText.length) };
  }
  if (newText.length > lastText.length && lastText.length >= 32) {
    for (const fpSize of [64, 48, 32, 24]) {
      if (lastText.length < fpSize) continue;
      const fingerprint = lastText.slice(-fpSize);
      const idx = newText.indexOf(fingerprint);
      if (idx === -1) continue;
      const expectedEnd = idx + lastText.length;
      if (expectedEnd > newText.length) continue;
      const overlap = newText.substring(expectedEnd - Math.min(20, lastText.length), expectedEnd);
      const lastTail = lastText.slice(-overlap.length);
      const overlapMatch = commonSuffixLen(overlap, lastTail);
      if (overlapMatch < overlap.length * 0.75 && overlapMatch < 3) continue;
      const delta = newText.substring(expectedEnd);
      if (delta) return { cumulative: true, delta };
    }
  }
  return { cumulative: false, delta: newText };
}

// ── Tool and streaming utilities ──────────────────────────────────

export const pendingCorrections = new Map<string, string[]>();

// Prevent unbounded growth: trim oldest entries every 5 minutes
const MAX_PENDING_CORRECTIONS = 500;
setInterval(
  () => {
    if (pendingCorrections.size > MAX_PENDING_CORRECTIONS) {
      const toDelete = pendingCorrections.size - MAX_PENDING_CORRECTIONS;
      let i = 0;
      for (const key of pendingCorrections.keys()) {
        if (i >= toDelete) break;
        pendingCorrections.delete(key);
        i++;
      }
    }
  },
  5 * 60 * 1000,
).unref();
