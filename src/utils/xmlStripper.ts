/**
 * Tool echo patterns — strip lines where the model echoes tool results
 * as JSON: [{"type":"function","tool":"name","result":{...}}]
 */
const TOOL_ECHO_PATTERNS: RegExp[] = [
  // Single-line JSON tool result echo: [{"type":"function","tool":"name","result":{...}}]
  /^\[\s*\{.*"type"\s*:\s*"function".*"tool"\s*:\s*"/i,
];

export function stripToolCallArtifacts(text: string): string {
  if (!text) return '';
  // Strip XML tool_result blocks (complete pairs)
  text = text.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, '');
  // Strip orphaned <tool_result without matching close
  const unmatchedOpenIdx = text.search(/<tool_result(?:\s[^>]*)?>/);
  if (unmatchedOpenIdx !== -1) { text = text.substring(0, unmatchedOpenIdx); }
  // Strip residual </tool_result> without matching open
  text = text.replace(/<\/tool_result\s*>/g, '');
  // Strip any </...tool_result> where prefix between </ and tool_result may be garbled
  // Use \w+ instead of [\s\S]*? to avoid eating surrounding text
  text = text.replace(/<\/\w+tool_result\s*>/g, '');
  // Strip partial / incomplete tool tags at end of text (streaming boundaries).
  // These are conservatively matched — only unambiguous tool tag prefixes.
  text = text.replace(/\n?<tool_result(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool_call(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool_use(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<function(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<parameter(?:\s[^>]*)?$/g, '');
  // Strip any remaining </tool or </tool_result prefix (with > requirement to avoid
  // matching </toolbox, </toolkit etc.)
  text = text.replace(/<\/tool(?:_result)?>/g, '');
  // Strip JSON tool result echo blocks (handles both single-line and pretty-printed multi-line):
  //   [{"type":"function","tool":"name","result":{"success":true,"stdout":"...","stderr":"","command":"name"}}]
  text = text.replace(/\[\s*\{[\s\S]*?"type"\s*:\s*"function"[\s\S]*?"tool"\s*:\s*"[a-z_]+"[\s\S]*?\}\s*\]/g, '');
  text = stripToolEcho(text);
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

export function stripStreamingDelta(delta: string): string {
  if (!delta) return '';
  let cleaned = delta;
  cleaned = cleaned.replace(/\[READ TOOL RESULT below[^\]]*\]\s*/g, '');
  cleaned = cleaned.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, '');
  // Strip partial tool tags at EOL (streaming chunk boundaries)
  cleaned = cleaned.replace(/\n?<tool_result(?:\s[^>]*)?$/g, '');
  cleaned = cleaned.replace(/\n?<tool_call(?:\s[^>]*)?$/g, '');
  cleaned = cleaned.replace(/\n?<function(?:\s[^>]*)?$/g, '');
  return cleaned;
}

export function stripToolEcho(text: string): string {
  if (!text) return '';
  let result = text;
  const originalLines = text.split('\n');
  const filteredLines: string[] = [];
  for (const line of originalLines) {
    const trimmed = line.trim();
    if (!trimmed) { filteredLines.push(line); continue; }
    let isEcho = false;
    for (const pattern of TOOL_ECHO_PATTERNS) {
      if (pattern.test(trimmed)) { isEcho = true; break; }
    }
    if (!isEcho) { filteredLines.push(line); }
  }
  result = filteredLines.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

export function repairMalformedJson(malformedJson: string): string | null {
  let fixed = malformedJson.trim();
  try { JSON.parse(fixed); return null; } catch { /* continue */ }
  fixed = fixed.replace(/'/g, '"');
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  fixed = fixed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
  const openBraces = (fixed.match(/{/g) || []).length;
  const closeBraces = (fixed.match(/}/g) || []).length;
  const openBrackets = (fixed.match(/\[/g) || []).length;
  const closeBrackets = (fixed.match(/\]/g) || []).length;
  if (openBraces > closeBraces) fixed += '}'.repeat(openBraces - closeBraces);
  if (openBrackets > closeBrackets) fixed += ']'.repeat(openBrackets - closeBrackets);
  try { JSON.parse(fixed); return fixed; } catch { return null; }
}
