/*
 * File: validation.ts
 * Request body validation schemas using zod (v3 compatibility via zod/v3).
 * Ensures incoming OpenAI-compatible requests are well-formed before processing.
 */

import { z } from 'zod/v3';

const contentPartSchema = z.object({
  type: z.string().max(32),
  text: z.string().max(2_000_000).optional(),
  image_url: z
    .object({
      url: z.string().max(4_000),
      detail: z.string().max(32).optional(),
    })
    .optional(),
});

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool', 'function']),
  content: z
    .union([z.string(), z.array(contentPartSchema), z.null()])
    .optional()
    .default(''),
  name: z.string().max(256).optional(),
  tool_call_id: z.string().max(256).optional(),
  reasoning_content: z.string().max(2_000_000).optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string().max(256).optional(),
        type: z.enum(['function']).optional(),
        function: z.object({
          name: z.string().min(1).max(256),
          arguments: z.string().max(1_000_000),
        }),
      }),
    )
    .optional(),
});

const functionSchema = z.object({
  type: z.enum(['function']),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
  inputSchema: z.record(z.unknown()).optional(),
});

export const openAIRequestSchema = z.object({
  model: z.string().min(1, 'model is required'),
  messages: z.array(messageSchema).min(1, 'at least one message is required').max(1000),
  stream: z.boolean().optional().default(false),
  tools: z.array(functionSchema).max(128).optional(),
  tool_choice: z
    .union([
      z.enum(['auto', 'none', 'required', 'any']),
      z.object({ type: z.enum(['function']), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .optional(),
  reasoning: z
    .object({
      effort: z.string().optional(),
    })
    .optional(),
  reasoning_effort: z.string().optional(),
  enable_thinking: z.boolean().optional(),
  extra_body: z.record(z.unknown()).optional(),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  max_completion_tokens: z.number().int().positive().max(1_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().positive().max(1).optional(),
  stop: z.union([z.string().max(256), z.array(z.string().max(256)).max(4)]).optional(),
});

export type ValidatedOpenAIRequest = z.infer<typeof openAIRequestSchema>;

export interface ValidationResult {
  ok: boolean;
  data?: ValidatedOpenAIRequest;
  error?: string;
  code?: string;
  status?: number;
}

export function validateOpenAIRequest(body: unknown): ValidationResult {
  const result = openAIRequestSchema.safeParse(body);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const firstIssue = result.error.issues[0];
  const path = firstIssue?.path?.join('.') || 'body';
  const message = firstIssue?.message || 'Invalid request';
  return {
    ok: false,
    error: `${path}: ${message}`,
    code: 'invalid_request_error',
    status: 400,
  };
}

const anthropicContentBlockSchema = z.object({
  type: z.string().min(1).max(32),
  text: z.string().max(2_000_000).optional(),
  source: z.record(z.unknown()).optional(),
  id: z.string().max(256).optional(),
  name: z.string().max(256).optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().max(256).optional(),
  content: z.union([z.string().max(2_000_000), z.array(z.unknown()).max(128)]).optional(),
});

export const anthropicRequestSchema = z.object({
  model: z.string().min(1).max(256),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.union([z.string().max(2_000_000), z.array(anthropicContentBlockSchema).max(128)]),
      }),
    )
    .min(1)
    .max(1000),
  system: z.string().max(2_000_000).optional(),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  stream: z.boolean().optional().default(false),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        description: z.string().max(100_000).optional(),
        input_schema: z.record(z.unknown()),
      }),
    )
    .max(128)
    .optional(),
  tool_choice: z.unknown().optional(),
  stop_sequences: z.array(z.string().max(256)).max(4).optional(),
  metadata: z.record(z.string().max(1000)).optional(),
  thinking: z.object({ enabled: z.boolean().optional() }).optional(),
});

export function validateAnthropicRequest(body: unknown): ValidationResult {
  const result = anthropicRequestSchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data as unknown as ValidatedOpenAIRequest };
  const firstIssue = result.error.issues[0];
  return {
    ok: false,
    error: `${firstIssue?.path?.join('.') || 'body'}: ${firstIssue?.message || 'Invalid request'}`,
    code: 'invalid_request_error',
    status: 400,
  };
}
