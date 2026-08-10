/*
 * File: providers/glm/stream.ts
 * GLM three-phase SSE stream parser — converts to OpenAI chat.completion.chunk format.
 *
 * Phases:
 *   thinking → emits reasoning_content delta
 *   answer   → emits content delta
 *   other    → carries usage stats
 *   done     → marks completion
 */

export interface GlmStreamState {
  content: string;
  thinkingContent: string;
  isFinished: boolean;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  currentPhase: 'thinking' | 'answer' | 'other' | 'done' | null;
}

export function createGlmStreamState(): GlmStreamState {
  return {
    content: '',
    thinkingContent: '',
    isFinished: false,
    usage: null,
    currentPhase: null,
  };
}

interface GlmSseData {
  type?: string;
  data?: {
    delta_content?: string;
    phase?: string;
    done?: boolean;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
}

/**
 * Parse a single SSE line from GLM and emit OpenAI-formatted chunks.
 * Handles three phases: thinking, answer, other (usage), done.
 *
 * Returns an array of SSE event strings (each prefixed with "data: " and suffixed with "\n\n").
 * Returns `done: true` when the stream is finished.
 */
export function parseGlmSseLine(
  line: string,
  state: GlmStreamState,
  model: string,
  sessionId: string,
): { chunks: string[]; done: boolean } {
  const chunks: string[] = [];

  if (!line.startsWith('data: ')) return { chunks, done: false };

  const raw = line.slice(6);
  if (raw === '[DONE]') {
    state.isFinished = true;
    return { chunks: ['data: [DONE]\n\n'], done: true };
  }

  let parsed: GlmSseData;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { chunks, done: false };
  }

  // Accept both top-level fields and nested under `type: "chat:completion"`
  const payload: Record<string, any> = parsed.data || parsed;
  if (!payload || (!payload.phase && !payload.delta_content && !payload.done)) {
    return { chunks, done: false };
  }

  const phase = payload.phase || '';
  const deltaContent = payload.delta_content || '';
  const created = Math.floor(Date.now() / 1000);

  state.currentPhase = phase as GlmStreamState['currentPhase'];

  switch (phase) {
    case 'thinking': {
      state.thinkingContent += deltaContent;
      const oaiEvent = JSON.stringify({
        id: sessionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: deltaContent },
            finish_reason: null,
          },
        ],
      });
      chunks.push(`data: ${oaiEvent}\n\n`);
      break;
    }

    case 'answer': {
      state.content += deltaContent;
      const oaiEvent = JSON.stringify({
        id: sessionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: deltaContent },
            finish_reason: null,
          },
        ],
      });
      chunks.push(`data: ${oaiEvent}\n\n`);
      break;
    }

    case 'other': {
      if (payload.usage) {
        state.usage = {
          prompt_tokens: payload.usage.prompt_tokens ?? 0,
          completion_tokens: payload.usage.completion_tokens ?? 0,
          total_tokens: payload.usage.total_tokens ?? 0,
        };
      }
      break;
    }

    case 'done': {
      state.isFinished = true;
      // Emit usage as the final chunk before [DONE]
      if (state.usage) {
        const usageEvent = JSON.stringify({
          id: sessionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
          usage: state.usage,
        });
        chunks.push(`data: ${usageEvent}\n\n`);
      }
      chunks.push('data: [DONE]\n\n');
      return { chunks, done: true };
    }

    default: {
      // Delta content without a recognized phase — emit as content
      if (deltaContent) {
        state.content += deltaContent;
        const oaiEvent = JSON.stringify({
          id: sessionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: deltaContent },
              finish_reason: null,
            },
          ],
        });
        chunks.push(`data: ${oaiEvent}\n\n`);
      }
      break;
    }
  }

  return { chunks, done: state.isFinished };
}
