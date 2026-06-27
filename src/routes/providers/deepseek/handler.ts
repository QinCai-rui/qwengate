/*
 * File: providers/deepseek/handler.ts
 * DeepSeek provider — uses per-account browser JWT via web chat API.
 * No API key fallback — accounts only.
 */

import { registerProvider } from '../../providerRegistry.ts';

export async function deepseekHandler(c: any, body: any): Promise<Response> {
  try {
    const { getProviderToken } = await import('../../../services/accountManager.ts');
    const token = getProviderToken('deepseek');
    if (token) {
      const { proxyViaDeepSeekWebChat } = await import('./pipeline.ts');
      return await proxyViaDeepSeekWebChat(c, body);
    }
  } catch {
    // Fall through to error
  }

  return c.json(
    {
      error: {
        message: 'No DeepSeek account logged in. Login via dashboard first.',
        type: 'auth_error',
      },
    },
    503,
  );
}

registerProvider('deepseek/', deepseekHandler);
