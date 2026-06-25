/*
 * File: providerModels.ts
 * Static model definitions for third-party providers.
 *
 * These models are merged with Qwen's dynamic model list in the /v1/models response.
 * Update this file when adding or removing provider models.
 */

export interface ProviderModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  description?: string;
}

// Base created timestamp — used so models sort consistently
const CREATED = 1_782_414_000; // 2026-06-25

export const PROVIDER_MODELS: ProviderModelEntry[] = [
  // ── DeepSeek ────────────────────────────────────────────
  {
    id: 'deepseek/instant',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Instant mode — fast responses',
  },
  {
    id: 'deepseek/expert',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Expert mode — deeper reasoning',
  },
  {
    id: 'deepseek/vision',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Vision mode — image understanding',
  },
  {
    id: 'deepseek/reasoner',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Reasoner — Expert + DeepThink (R1)',
  },
  // ── Z.ai (Zhipu GLM) ────────────────────────────────────
  {
    id: 'zai/glm-5.2',
    object: 'model',
    created: CREATED,
    owned_by: 'zai',
    description: 'Z.ai GLM-5.2 — flagship model, excels at coding and long-horizon tasks',
  },
  {
    id: 'zai/glm-4.7',
    object: 'model',
    created: CREATED,
    owned_by: 'zai',
    description: 'Z.ai GLM-4.7 — fast and efficient',
  },
];

/**
 * Return all provider model entries.
 * Separated from the inline list so tests can import it easily.
 */
export function getProviderModels(): ProviderModelEntry[] {
  return [...PROVIDER_MODELS];
}

const PROVIDER_MODEL_SPECS: Record<string, { max_context: number; max_output: number; modalities: string[] }> = {
  'deepseek/instant': { max_context: 32000, max_output: 8000, modalities: ['text'] },
  'deepseek/expert': { max_context: 64000, max_output: 8000, modalities: ['text'] },
  'deepseek/vision': { max_context: 32000, max_output: 8000, modalities: ['text', 'image'] },
  'deepseek/reasoner': { max_context: 64000, max_output: 8000, modalities: ['text'] },
  'zai/glm-5.2': { max_context: 32000, max_output: 16000, modalities: ['text', 'image'] },
  'zai/glm-4.7': { max_context: 32000, max_output: 16000, modalities: ['text', 'image'] },
};

export function getProviderModelSpecs(modelId: string): { max_context: number; max_output: number; modalities: string[] } | null {
  return PROVIDER_MODEL_SPECS[modelId] || null;
}
