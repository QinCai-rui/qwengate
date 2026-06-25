/*
 * File: providers/zai/handler.ts
 * Z.ai provider -- OpenAI-compatible fetch proxy via factory.
 */

import { registerProvider } from '../../providerRegistry.ts';
import { createOpenAIProxyHandler } from '../openaiProxy.ts';

registerProvider('zai/', createOpenAIProxyHandler('zai', 'ZAI_API_KEY', 'ZAI_BASE_URL', 'https://api.z.ai'));
