import type { ParsedToolCall, ToolCallResult } from './types.ts';
import { registry } from './registry.ts';
import { validateToolCalls } from './guard.ts';
import {
  parseToolCallsFromContent, executeToolCalls, buildToolMessage,
  buildAssistantToolCallMessage, normalizeToolCalls
} from './toolRunner.ts';

export { parseToolCallsFromContent, executeToolCalls } from './toolRunner.ts';

export interface ExecutionLoopConfig {
  maxTurns?: number;
  debug?: boolean;
  maxConcurrency?: number;
  toolTimeoutMs?: number;
  maxToolCallsPerRequest?: number;
  sanitize?: SanitizeConfig;
}

export interface SanitizeConfig {
  max_length?: number;
  strip_secrets?: boolean;
  compress_whitespace?: boolean;
}

export interface LoopTurnResult {
  toolCalls: ParsedToolCall[];
  toolResults: ToolCallResult[];
  content: string | null;
  finishReason: string | null;
  turn: number;
}

export type LLMSendFunction = (
  messages: unknown[],
  tools: unknown[] | undefined,
  model: string
) => Promise<LLMResponse>;

export interface LLMResponse {
  content: string | null;
  toolCalls: ParsedToolCall[];
  finishReason: string;
}

const DEFAULT_MAX_CONCURRENCY = 10;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_GUARD_RETRIES = 3;

export async function runExecutionLoop(
  sendToLLM: LLMSendFunction,
  messages: unknown[],
  model: string,
  config: ExecutionLoopConfig = {}
): Promise<string> {
  const debug = config.debug ?? false;
  const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const toolTimeoutMs = config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  let consecutiveGuardFailures = 0;
  let lastGuardErrors = '';
  const toolCallWindow: string[] = [];
  let turn = 0;
  const tools = registry.listNames().length > 0 ? registry.toOpenAITools() : undefined;

  while (true) {
    turn++;
    const response = await sendToLLM(messages, tools, model);
    const hasStructuredToolCalls = response.toolCalls && response.toolCalls.length > 0;
    let parsedFromContent: { textContent: string; toolCalls: ParsedToolCall[] } | null = null;
    if (!hasStructuredToolCalls && response.content) {
      parsedFromContent = parseToolCallsFromContent(response.content);
    }
    const effectiveToolCalls = hasStructuredToolCalls ? response.toolCalls : parsedFromContent?.toolCalls || [];
    const effectiveContent = parsedFromContent ? parsedFromContent.textContent : response.content;
    if (effectiveToolCalls.length === 0) {
      return effectiveContent || '';
    }

    const guardResult = validateToolCalls(effectiveToolCalls);
    if (!guardResult.ok) {
      const errorKey = guardResult.errors.join('|');
      if (errorKey === lastGuardErrors) { consecutiveGuardFailures++; }
      else { consecutiveGuardFailures = 1; lastGuardErrors = errorKey; }
      if (consecutiveGuardFailures >= MAX_GUARD_RETRIES) {
        const normResult = normalizeToolCalls(effectiveToolCalls);
        if (normResult.fixed.length > 0) {
          effectiveToolCalls.length = 0;
          effectiveToolCalls.push(...normResult.fixed);
          const repairedGuard = validateToolCalls(effectiveToolCalls);
          if (repairedGuard.ok) { consecutiveGuardFailures = 0; }
          else {
            throw new Error(
              `Tool call format correction failed after auto-repair. ` +
              `Original: ${guardResult.errors.join('; ')}. Fixed: ${repairedGuard.errors.join('; ')}`
            );
          }
        } else {
          throw new Error(
            `Tool call format correction failed after ${consecutiveGuardFailures} attempts. ` +
            `Errors: ${guardResult.errors.join('; ')}`
          );
        }
      }
      if (debug) {
        console.error(`[executor] tool call validation FAILED (attempt ${consecutiveGuardFailures}/${MAX_GUARD_RETRIES}):`, guardResult.errors);
      }
      const escalation = [
        '',
        `  FIX YOUR FORMAT. Use: {"name":"tool","arguments":{"key":"value"}}`,
        `  CRITICAL: Your tool calls are STILL broken. You MUST output PURE JSON only. No wrappers, no fences, no markdown. Correct format: {"name":"tool_name","arguments":{"param":"value"}}`,
      ];
      messages.push({
        role: 'system',
        content: guardResult.correctionPrompt + (escalation[consecutiveGuardFailures - 1] || ''),
      });
      continue;
    }
    consecutiveGuardFailures = 0;

    for (const tc of guardResult.valid) {
      const key = `${tc.name}|${JSON.stringify(tc.arguments)}`;
      toolCallWindow.push(key);
      if (toolCallWindow.length > 20) toolCallWindow.shift();
    }
    const recentCount = toolCallWindow.slice(-10).length;
    const uniqueRecent = new Set(toolCallWindow.slice(-10)).size;
    if (recentCount > 3 && uniqueRecent <= 2) {
      messages.push({
        role: 'system',
        content: '[SYSTEM: You appear to be calling the same tools repeatedly without progress. Please vary your approach or provide a text response.]',
      });
    }

    messages.push(buildAssistantToolCallMessage(effectiveContent, guardResult.valid));
    const toolResults = await executeToolCalls(
      guardResult.valid, { messages, turn, model }, maxConcurrency, toolTimeoutMs
    );
    const errorResults = toolResults.filter(r => r.isError);
    if (debug && errorResults.length > 0) {
      console.error(`[executor] ${errorResults.length}/${toolResults.length} tool calls failed`);
    }
    for (const result of toolResults) {
      messages.push(buildToolMessage(result));
    }
  }
}
