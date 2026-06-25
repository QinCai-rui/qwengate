import modelSpecs from '../models.json' with { type: 'json' };
import type { ModelSpec } from '../types/openai.ts';

export function handleImageModelFallback(body: any, messages: any[]): void {
  const hasImages = messages.some((m) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'));
  if (hasImages) {
    const modelId = (body.model as string)
      .toLowerCase()
      .replace(/\./g, '-')
      .replace(/-no-thinking$/, '');
    const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
    const supportsImages = specs?.modalities.includes('image');
    if (!supportsImages) {
      const original = body.model;
      body.model = 'qwen3.7-plus' + (original.includes('-no-thinking') ? '-no-thinking' : '');
    }
  }
}

export function getModelSpecs(body: any): { maxContext: number; maxOutput: number } {
  const modelId = (body.model as string)
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/-no-thinking$/, '');
  const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
  return {
    maxContext: specs?.max_context || 250000,
    maxOutput: specs?.max_output || 65000,
  };
}
