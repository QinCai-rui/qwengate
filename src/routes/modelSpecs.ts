import { fetchQwenModels } from '../services/qwenModels.ts';
import type { ModelSpec } from '../types/openai.ts';

let specsCache: Record<string, ModelSpec> | null = null;
let cachePromise: Promise<void> | null = null;

async function ensureSpecsCache(): Promise<void> {
  if (specsCache) return;
  if (cachePromise) await cachePromise;
  cachePromise = (async () => {
    try {
      const models = await fetchQwenModels();
      const cache: Record<string, ModelSpec> = {};
      for (const m of models) {
        // Key by dash-convention (qwen3-7-max) matching existing callers
        const key = m.id.replace(/\./g, '-');
        cache[key] = {
          max_context: m.context_window ?? 1000000,
          max_output: m.max_output_tokens ?? 65536,
          modalities: m.modalities ?? ['text'],
        };
      }
      specsCache = cache;
    } catch {
      specsCache = {}; // empty cache -> callers use defaults
    }
  })();
  await cachePromise;
}

function normalizeModel(body: any): string {
  return (body.model as string)
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/-no-thinking$/, '');
}

export async function handleImageModelFallback(body: any, messages: any[]): Promise<void> {
  const hasImages = messages.some((m) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'));
  if (!hasImages) return;

  await ensureSpecsCache();
  const modelId = normalizeModel(body);
  const specs = specsCache?.[modelId];
  const supportsImages = specs?.modalities?.includes('image');
  if (!supportsImages) {
    const original = body.model as string;
    body.model = 'qwen3.7-plus' + (original.includes('-no-thinking') ? '-no-thinking' : '');
  }
}

export async function getModelSpecs(body: any): Promise<{ maxContext: number; maxOutput: number }> {
  await ensureSpecsCache();
  const modelId = normalizeModel(body);
  const specs = specsCache?.[modelId];
  return {
    maxContext: specs?.max_context || 250000,
    maxOutput: specs?.max_output || 65000,
  };
}
