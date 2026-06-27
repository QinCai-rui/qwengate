/*
 * File: providers/zai/handler.ts
 * Z.ai (GLM) provider — uses per-account browser JWT via web chat API.
 * No API key fallback — accounts only.
 */

import { registerProvider } from '../../providerRegistry.ts';

export async function zaiHandler(c: any, body: any): Promise<Response> {
  try {
    const { getProviderToken } = await import('../../../services/accountManager.ts');
    const token = getProviderToken('zai');
    if (token) {
      const { proxyViaZaiWebChat } = await import('./pipeline.ts');
      return await proxyViaZaiWebChat(c, body, token);
    }
  } catch {
    // Fall through to error
  }

  return c.json(
    {
      error: {
        message: 'No Z.ai account logged in. Login via dashboard first.',
        type: 'auth_error',
      },
    },
    503,
  );
}

registerProvider('zai/', zaiHandler);
