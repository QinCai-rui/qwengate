/*
 * File: providers/glm/handler.ts
 * GLM provider — uses per-account browser JWT via web chat API.
 * No API key fallback — accounts only.
 */

import { registerProvider } from '../../providerRegistry.ts';

export async function glmHandler(c: any, body: any): Promise<Response> {
  try {
    const { getProviderToken } = await import('../../../services/accountManager.ts');
    const token = getProviderToken('glm');
    if (token) {
      const { proxyViaGlmWebChat } = await import('./pipeline.ts');
      return await proxyViaGlmWebChat(c, body, token);
    }
  } catch {
    // Fall through to error
  }

  return c.json(
    {
      error: {
        message: 'No GLM account logged in. Login via dashboard first.',
        type: 'auth_error',
      },
    },
    503,
  );
}

registerProvider('glm/', glmHandler);
