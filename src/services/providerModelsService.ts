/*
 * File: providerModelsService.ts
 * Fetches models from OpenAI-compatible provider APIs (DeepSeek, GLM).
 * ponytail: simple fetch + cache for OpenAI-compatible provider models
 */

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ProviderConfig {
  baseUrl: string;
  modelsPath: string;
  apiKeyVar: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    modelsPath: '/models',
    apiKeyVar: 'DEEPSEEK_API_KEY',
  },
  glm: {
    baseUrl: 'https://open.bigmodel.cn',
    modelsPath: '/api/paas/v4/models',
    apiKeyVar: 'ZAI_API_KEY',
  },
};

// ponytail: global in-memory cache, per-provider TTL
const cache = new Map<string, { models: ModelEntry[]; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function fetchProviderModels(prefix: string): Promise<ModelEntry[]> {
  const cfg = PROVIDER_CONFIGS[prefix];
  if (!cfg) return [];

  const now = Date.now();
  const cached = cache.get(prefix);
  if (cached && now - cached.ts < CACHE_TTL) return cached.models;

  const apiKey = process.env[cfg.apiKeyVar];
  if (!apiKey) return [];

  try {
    const response = await fetch(cfg.baseUrl + cfg.modelsPath, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const json: any = await response.json();
    if (!json.data || !Array.isArray(json.data)) return [];

    const models: ModelEntry[] = json.data.map((m: any) => ({
      id: `${prefix}/${m.id}`, // prefix so handler can strip it back
      object: 'model',
      created: m.created || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || prefix,
    }));

    cache.set(prefix, { models, ts: now });
    return models;
  } catch {
    return [];
  }
}
