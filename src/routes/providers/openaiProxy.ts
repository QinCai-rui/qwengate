/*
 * File: providers/openaiProxy.ts
 * Factory for OpenAI-compatible provider handlers.
 * Each provider is a single registerProvider() call.
 */

import type { Context } from 'hono';
import type { OpenAIRequest } from '../../types/openai.ts';
import type { ProviderHandler } from '../providerRegistry.ts';

export function createOpenAIProxyHandler(prefix: string, envApiKey: string, envBaseUrl: string, defaultBaseUrl: string): ProviderHandler {
  return async (c: Context, body: OpenAIRequest): Promise<Response> => {
    const apiKey = process.env[envApiKey];
    if (!apiKey) {
      return c.json({ error: { message: `${envApiKey} environment variable not set`, type: 'server_error' } }, 503);
    }

    const baseUrl = (process.env[envBaseUrl] || defaultBaseUrl).replace(/\/$/, '');
    const isStream = body.stream === true;
    const upstreamModel = body.model.replace(new RegExp(`^${prefix}/`), '');

    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, model: upstreamModel }),
      signal: AbortSignal.timeout(120000),
    });

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: {
        'Content-Type': isStream ? 'text/event-stream' : 'application/json',
      },
    });
  };
}
