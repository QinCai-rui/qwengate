/*
 * File: json.ts
 * Project: qwenproxy
 * Robust JSON parsing utilities
 */

/**
 * Remove trailing commas before } or ] in JSON strings.
 * LLMs often produce: {"items": ["a", "b",]} or {"a": 1,}
 * This is string-aware — it won't modify commas inside quoted values.
 */
function removeTrailingCommas(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }

    if (!inString && char === ',') {
      // Look ahead past whitespace to see if next non-whitespace is } or ]
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      if (j < json.length && (json[j] === '}' || json[j] === ']')) {
        // Skip this trailing comma
        continue;
      }
    }

    result += char;
  }

  return result;
}

/**
 * Escape control characters in JSON strings and track brace/bracket depth.
 * Returns the escaped string along with depth tracking information for balancing.
 */
function escapeControlChars(input: string): {
  fixedJson: string;
  openBraces: number;
  openBrackets: number;
  lastBalancedIndex: number;
} {
  let fixedJson = '';
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;
  let lastBalancedIndex = -1;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      const validEscapes = ['n', 'r', 't', 'u', '"', '\\', '/'];
      if (validEscapes.includes(char)) {
        if (char === 'u') {
          const next4 = input.substring(i + 1, i + 5);
          const isHex = /^[0-9a-fA-F]{4}$/.test(next4);
          if (isHex) {
            fixedJson += '\\' + char;
          } else {
            fixedJson += '\\\\' + char;
          }
        } else if (['n', 'r', 't'].includes(char)) {
          const nextChar = input[i + 1] || '';
          const isWinPath = /[a-zA-Z]:\\/i.test(input.substring(0, i)) || /[a-zA-Z]:\//i.test(input.substring(0, i));
          if (isWinPath && /^[a-zA-Z0-9]/.test(nextChar)) {
            fixedJson += '\\\\' + char;
          } else {
            fixedJson += '\\' + char;
          }
        } else {
          fixedJson += '\\' + char;
        }
      } else {
        fixedJson += '\\\\' + char;
      }
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      fixedJson += char;
      continue;
    }

    if (inString) {
      // Escape literal control characters that are invalid in JSON strings
      if (char === '\n') fixedJson += '\\n';
      else if (char === '\r') fixedJson += '\\r';
      else if (char === '\t') fixedJson += '\\t';
      else if (char.charCodeAt(0) < 32) {
        fixedJson += '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
      }
      else fixedJson += char;
    } else {
      fixedJson += char;
      if (char === '{') openBraces++;
      if (char === '}') openBraces--;
      if (char === '[') openBrackets++;
      if (char === ']') openBrackets--;

      if (openBraces === 0 && openBrackets === 0 && i > 0) {
        lastBalancedIndex = fixedJson.length - 1;
      }
    }
  }

  return { fixedJson, openBraces, openBrackets, lastBalancedIndex };
}

/**
 * Balance unmatched braces/brackets by either truncating at the last balanced
 * point or appending closing characters.
 */
function balanceBraces(
  fixedJson: string,
  openBraces: number,
  openBrackets: number,
  lastBalancedIndex: number,
): string {
  if (lastBalancedIndex !== -1 && (openBraces !== 0 || openBrackets !== 0 || fixedJson.length > lastBalancedIndex + 1)) {
    return fixedJson.substring(0, lastBalancedIndex + 1);
  }
  if (openBraces > 0 || openBrackets > 0) {
    let result = fixedJson;
    if (openBrackets > 0) result += ']'.repeat(openBrackets);
    if (openBraces > 0) result += '}'.repeat(openBraces);
    return result;
  }
  return fixedJson;
}

/**
 * Aggressive fallback repair: trim trailing comma, re-escape control chars,
 * re-balance braces. Used when initial escaping + balancing fails to produce valid JSON.
 */
function aggressiveRepair(fixedJson: string): string {
  let s = fixedJson.trim();
  if (s.endsWith(',')) s = s.slice(0, -1);
  const { fixedJson: aggFixed, openBraces, openBrackets } = escapeControlChars(s);
  let result = aggFixed;
  if (openBrackets > 0) result += ']'.repeat(openBrackets);
  if (openBraces > 0) result += '}'.repeat(openBraces);
  return result;
}

export function robustParseJSON(str: string): any {
  const trimmed = str.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // non-blocking: fall through to progressive repair below
  }

  const firstBrace = trimmed.indexOf('{');
  if (firstBrace === -1) return null;

  const jsonPart = trimmed.substring(firstBrace);

  try {
    return JSON.parse(jsonPart);
  } catch {
    // non-blocking: fall through to aggressive repair heuristics below
  }


  // 0. Fix unquoted property names (e.g., arguments instead of "arguments")
  // We apply this to jsonPart and use the result for subsequent fixes
  let currentJson = jsonPart.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

  // 0b. Fix trailing commas inside arrays/objects (e.g., [a, b,] -> [a, b])
  currentJson = removeTrailingCommas(currentJson);

  // 0. Fix common LLM hallucinations
  // Fix double key names like {"name": "name": "tool"} -> {"name": "tool"}
  currentJson = currentJson.replace(/([{,]\s*)"([a-zA-Z0-9_]+)"\s*:\s*"\2"\s*:/g, '$1"$2":');
  // Fix unquoted double key names like {name: name: "tool"} -> {name: "tool"}
  currentJson = currentJson.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:\s*\2\s*:/g, '$1$2:');

  try {
    return JSON.parse(currentJson);
  } catch (_e) {
    // Still fails, continue to more complex fixes
  }

  // 1. Clean trailing noise from the end of the string
  let cleaned = currentJson.trim();
  while (cleaned.length > 0 && !/[}\]"0-9a-z]/i.test(cleaned[cleaned.length - 1])) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  const { fixedJson, openBraces, openBrackets, lastBalancedIndex } = escapeControlChars(cleaned);
  const tempJson = balanceBraces(fixedJson, openBraces, openBrackets, lastBalancedIndex);

  try {
    return JSON.parse(tempJson);
  } catch (e) {
    const repaired = aggressiveRepair(fixedJson);
    try {
      return JSON.parse(repaired);
    } catch {
      throw e; // Throw original error if all fixes fail
    }
  }
}
