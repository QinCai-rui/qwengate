import { getQwenHeaders, getBasicHeaders } from './playwright.ts';
import { v4 as uuidv4 } from 'uuid';
import modelSpecs from '../models.json' with { type: 'json' };
import type { ModelSpec } from '../types/openai.ts';
import { getAllAccountEmails } from './auth.ts';
import { createNetworkEntry, recordResponse, completeEntry, errorEntry } from './networkDebug.ts';
import { config } from './configService.ts';

const QWEN_FETCH_TIMEOUT_MS = parseInt(config.get('QWEN_FETCH_TIMEOUT_MS', '30000'), 10);

function createFetchTimeout(): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QWEN_FETCH_TIMEOUT_MS);
  return { controller, cleanup: () => clearTimeout(timeout) };
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;
let nativeToolsDisabled = false;
let disablingNativeToolsInProgress: Promise<void> | null = null;
let personalizationDisabled = false;
let disablingPersonalizationInProgress: Promise<void> | null = null;

export async function disableNativeTools(): Promise<void> {
  if (nativeToolsDisabled) return;
  if (disablingNativeToolsInProgress) { await disablingNativeToolsInProgress; return; }
  disablingNativeToolsInProgress = (async () => {
    let settingsDebugId: string | null = null;
    try {
      const { headers } = await getQwenHeaders();
      const payload = {
        tools_enabled: {
          web_extractor: false, web_search_image: false, web_search: false,
          image_gen_tool: false, code_interpreter: false, history_retriever: false,
          image_edit_tool: false, bio: false, image_zoom_in_tool: false, image_search: false
        }
      };
      const settingsHeaders: Record<string, string> = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'pt-BR,pt;q=0.9',
        'content-type': 'application/json',
        'cookie': headers['cookie'],
        'origin': 'https://chat.qwen.ai',
        'referer': 'https://chat.qwen.ai/',
        'user-agent': headers['user-agent'],
        'x-request-id': uuidv4(),
        'bx-ua': headers['bx-ua'],
        'bx-umidtoken': headers['bx-umidtoken'],
        'bx-v': headers['bx-v']
      };
      const settingsDebugEntry = createNetworkEntry({
        url: 'https://chat.qwen.ai/api/v2/users/user/settings/update',
        method: 'POST', headers: settingsHeaders, body: payload, category: 'settings',
      });
      settingsDebugId = settingsDebugEntry.id;
      const { controller, cleanup } = createFetchTimeout();
      let response: Response;
      try {
        response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
          method: 'POST', headers: settingsHeaders, body: JSON.stringify(payload), signal: controller.signal,
        });
      } finally { cleanup(); }
      recordResponse(settingsDebugId, response);
      if (!response.ok) {
        const text = await response.text();
        console.error(`[Qwen] Failed to disable native tools: ${response.status} - ${text}`);
        completeEntry(settingsDebugId);
      } else { nativeToolsDisabled = true; completeEntry(settingsDebugId); }
    } catch (err: any) {
      if (settingsDebugId) errorEntry(settingsDebugId, err.message);
      console.error(`[Qwen] Error disabling native tools: ${err.message}`);
    } finally { disablingNativeToolsInProgress = null; }
  })();
  return disablingNativeToolsInProgress;
}

export async function disablePersonalization(): Promise<void> {
  if (personalizationDisabled) return;
  if (disablingPersonalizationInProgress) { await disablingPersonalizationInProgress; return; }
  disablingPersonalizationInProgress = (async () => {
    const emails = getAllAccountEmails();
    const accountsToProcess = emails.length > 0 ? emails : ['primary'];
    for (const email of accountsToProcess) {
      let settingsDebugId: string | null = null;
      try {
        const { headers } = await getQwenHeaders(email);
        const payload = {
          memory: { enable_memory: false, enable_history_memory: false, memory_version_reminder: false },
          mcp: { 'code-interpreter': false, 'fire-crawl': false, 'amap': false, 'image-generation': false },
        };
        const settingsHeaders: Record<string, string> = {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'pt-BR,pt;q=0.9',
          'content-type': 'application/json',
          'cookie': headers['cookie'],
          'origin': 'https://chat.qwen.ai',
          'referer': 'https://chat.qwen.ai/',
          'user-agent': headers['user-agent'],
          'x-request-id': uuidv4(),
          'bx-ua': headers['bx-ua'],
          'bx-umidtoken': headers['bx-umidtoken'],
          'bx-v': headers['bx-v'],
        };
        const settingsDebugEntry = createNetworkEntry({
          url: 'https://chat.qwen.ai/api/v2/users/user/settings/update',
          method: 'POST', headers: settingsHeaders, body: payload, category: 'settings',
        });
        settingsDebugId = settingsDebugEntry.id;
        const { controller, cleanup } = createFetchTimeout();
        let response: Response;
        try {
          response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
            method: 'POST', headers: settingsHeaders, body: JSON.stringify(payload), signal: controller.signal,
          });
        } finally { cleanup(); }
        recordResponse(settingsDebugId, response);
        if (!response.ok) {
          const text = await response.text();
          console.error(`[Qwen] Failed to disable personalization for ${email}: ${response.status} - ${text}`);
        }
        completeEntry(settingsDebugId);
      } catch (err: any) {
        if (settingsDebugId) errorEntry(settingsDebugId, err.message);
        console.error(`[Qwen] Error disabling personalization for ${email}: ${err.message}`);
      }
    }
    personalizationDisabled = true;
  })();
  return disablingPersonalizationInProgress;
}

export async function fetchQwenModels(): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) { return cachedModels; }
  const { cookie, userAgent, bxV } = await getBasicHeaders();
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let modelsDebugId: string | null = null;
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500 * attempt));
      const modelsHeaders: Record<string, string> = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'pt-BR,pt;q=0.9',
        'cookie': cookie,
        'referer': 'https://chat.qwen.ai/',
        'user-agent': userAgent,
        'x-request-id': uuidv4(),
        'bx-v': bxV,
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'source': 'web'
      };
      const modelsDebugEntry = createNetworkEntry({
        url: 'https://chat.qwen.ai/api/models',
        method: 'GET', headers: modelsHeaders, category: 'models',
      });
      modelsDebugId = modelsDebugEntry.id;
      const { controller, cleanup } = createFetchTimeout();
      let response: Response;
      try {
        response = await fetch('https://chat.qwen.ai/api/models', { headers: modelsHeaders, signal: controller.signal });
      } finally { cleanup(); }
      recordResponse(modelsDebugId, response);
      if (!response.ok) throw new Error(`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`);
      const json = await response.json();
      if (!json.data || !Array.isArray(json.data)) {
        console.warn(`[Qwen] fetchQwenModels: response missing data array, returning cached or empty`);
        completeEntry(modelsDebugId);
        return cachedModels || [];
      }
      const models = json.data.map((m: any) => {
        const id = (m.id as string).toLowerCase().replace(/\./g, '-');
        const typedSpecs = modelSpecs as Record<string, ModelSpec>;
        const specs = typedSpecs[id] || typedSpecs[id.replace(/-no-thinking$/, '')] || { max_context: 1000000, max_output: 65536, modalities: ['text'] };
        return {
          id: m.id, object: 'model',
          created: m.info?.created_at || Math.floor(Date.now() / 1000),
          owned_by: m.owned_by || 'qwen',
          context_window: specs.max_context,
          max_output_tokens: specs.max_output,
          modalities: specs.modalities,
        };
      });
      const extendedModels = [...models];
      for (const m of models) { extendedModels.push({ ...m, id: `${m.id}-no-thinking` }); }
      cachedModels = extendedModels;
      lastModelsFetch = now;
      completeEntry(modelsDebugId);
      return extendedModels;
    } catch (err: any) {
      if (modelsDebugId) errorEntry(modelsDebugId, err.message);
      lastErr = err;
    }
  }
  console.error(`[Qwen] fetchQwenModels failed after 3 attempts:`, lastErr?.message);
  return cachedModels || [];
}
