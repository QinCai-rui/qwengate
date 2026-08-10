/*
 * File: providerModels.ts
 * Static model definitions for third-party providers.
 *
 * These models are merged with Qwen's dynamic model list in the /v1/models response.
 * Update this file when adding or removing GLM models.
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
  // ponytail: upstream model IDs as of 2026-06 from GET /models
  {
    id: 'deepseek/deepseek-chat',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Chat — general-purpose chat',
  },
  {
    id: 'deepseek/deepseek-reasoner',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek Reasoner — chain-of-thought reasoning (R1)',
  },
  {
    id: 'deepseek/deepseek-vl2',
    object: 'model',
    created: CREATED,
    owned_by: 'deepseek',
    description: 'DeepSeek VL2 — vision-language understanding',
  },
  // ── GLM (Zhipu) ──────────────────────────────────────────
  {
    id: 'glm/glm-5.2',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-5.2 — flagship model, excels at coding and long-horizon tasks',
  },
  {
    id: 'glm/glm-5.1',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-5.1',
  },
  {
    id: 'glm/glm-5',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-5',
  },
  {
    id: 'glm/glm-4.7-flash',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.7 Flash — fast and efficient',
  },
  {
    id: 'glm/glm-4.7',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.7',
  },
  {
    id: 'glm/glm-4.6',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.6',
  },
  {
    id: 'glm/glm-4.5-air',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.5 Air — lightweight',
  },
  {
    id: 'glm/glm-4.5',
    object: 'model',
    created: CREATED,
    owned_by: 'glm',
    description: 'GLM-4.5',
  },
];

const PROVIDER_MODEL_SPECS: Record<string, { max_context: number; max_output: number; modalities: string[] }> = {
  'deepseek/deepseek-chat': { max_context: 128000, max_output: 8192, modalities: ['text'] },
  'deepseek/deepseek-reasoner': { max_context: 128000, max_output: 8192, modalities: ['text'] },
  'deepseek/deepseek-vl2': { max_context: 32000, max_output: 8192, modalities: ['text', 'image'] },
  'glm/glm-5.2': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-5.1': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-5': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.7-flash': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.7': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.6': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.5-air': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
  'glm/glm-4.5': { max_context: 131072, max_output: 16384, modalities: ['text', 'image'] },
};
