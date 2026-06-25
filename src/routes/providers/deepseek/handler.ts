/*
 * File: providers/deepseek/handler.ts
 * DeepSeek provider -- OpenAI-compatible fetch proxy via factory.
 */

import { registerProvider } from '../../providerRegistry.ts';
import { createOpenAIProxyHandler } from '../openaiProxy.ts';

registerProvider('deepseek/', createOpenAIProxyHandler('deepseek', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com'));
