import { isThinkingLine, QWEN_THINK_TAG_PATTERN, QWEN_THINK_BLOCK_START } from './thinkTagStripper.ts';
import type { FilterResult } from './thinkTagStripper.ts';
export type { FilterResult } from './thinkTagStripper.ts';

export function filterContent(raw: string): FilterResult {
  if (!raw) return { cleanText: '', thinking: '' };

  let text = raw;
  const capturedThinking: string[] = [];

  while (true) {
    const startMatch = text.match(QWEN_THINK_BLOCK_START);
    if (!startMatch) break;

    const startIdx = startMatch.index!;
    const startTagEnd = text.indexOf('>', startIdx) + 1;

    const endTagName = text.substring(startIdx + 1, text.indexOf('>', startIdx));
    const endPattern = new RegExp(`</${endTagName.replace(/[\s>].*/, '')}>`, 'i');
    const endMatch = text.substring(startTagEnd).match(endPattern);

    if (endMatch) {
      const endIdx = startTagEnd + endMatch.index!;
      const thinkContent = text.substring(startTagEnd, endIdx);
      if (thinkContent.trim()) {
        capturedThinking.push(thinkContent.trim());
      }
      const before = text.substring(0, startIdx);
      const after = text.substring(endIdx + endMatch[0].length);
      const needsSpace = before.length > 0 && !/[\s\n]$/.test(before) && after.length > 0 && !/^[\s\n]/.test(after);
      text = before + (needsSpace ? ' ' : '') + after;
    } else {
      capturedThinking.push(text.substring(startTagEnd).trim());
      const before = text.substring(0, startIdx);
      text = before + (before.length > 0 && !/[\s\n]$/.test(before) ? ' ' : '');
      break;
    }
  }

  text = text.replace(QWEN_THINK_TAG_PATTERN, ' ');

  const paragraphs = text.split(/\n\s*\n/);
  const cleanParagraphs: string[] = [];

  for (const para of paragraphs) {
    const paraLines = para.split('\n').filter(l => l.trim().length > 0);
    if (paraLines.length === 0) {
      cleanParagraphs.push('');
      continue;
    }

    const thinkingCount = paraLines.filter(l => isThinkingLine(l)).length;
    const startsWithThinking = isThinkingLine(paraLines[0]);
    const isStrongThinkingStart = /^Thinking:/i.test(paraLines[0]) || /^I am (evaluating|examining|assessing|analyzing)/i.test(paraLines[0]);

    const hasContentMarker = paraLines.some(l =>
      /^[#]{1,4}\s/.test(l) ||
      /^\$\s/.test(l) ||
      /^[|+-]{2,}/.test(l) ||
      /^\|.*\|/.test(l) ||
      /^[[{"]/.test(l) ||
      /^[✓✗✔✘✅❌]/.test(l) ||
      /^[A-Z][a-z]+ [a-z]+:/.test(l)
    );

    if (isStrongThinkingStart && !hasContentMarker) {
      capturedThinking.push(paraLines.join('\n'));
    } else if (thinkingCount >= 2 && !hasContentMarker) {
      capturedThinking.push(paraLines.join('\n'));
    } else if (startsWithThinking && thinkingCount === 1 && paraLines.length === 1) {
      cleanParagraphs.push(para);
    } else {
      cleanParagraphs.push(para);
    }
  }

  text = cleanParagraphs.join('\n\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\[READ TOOL RESULT below[^\]]*\]\s*/g, '');
  return {
    cleanText: text,
    thinking: capturedThinking.filter(t => t.length > 0).join('\n'),
  };
}
