import crypto from 'node:crypto';
import modelSpecs from '../models.json' with { type: 'json' };
import type { ModelSpec } from '../types/openai.ts';
import { decrementInFlight, getAllAccountEmails } from './auth.ts';
import { config } from './configService.ts';
import { DEFAULT_SYSTEM_PROMPT } from './defaultSystemPrompt.ts';
import { logStore } from './logStore.ts';
import { completeEntry, createNetworkEntry, errorEntry, recordResponse } from './networkDebug.ts';
import { getBasicHeaders, getQwenHeaders } from './playwright.ts';
import { createFetchTimeout, QWEN_API_BASE, QWEN_CHATS_URL, QWEN_MODELS_URL, QWEN_SETTINGS_URL } from './qwen.ts';

export { DEFAULT_SYSTEM_PROMPT };

const cachedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function makeQwenSettingsHeaders(qwenHeaders: Record<string, string>, contentType = true): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9',
    ...(contentType ? { 'content-type': 'application/json' } : {}),
    cookie: qwenHeaders['cookie'],
    origin: QWEN_API_BASE,
    referer: 'https://chat.qwen.ai/',
    'user-agent': qwenHeaders['user-agent'],
    'x-request-id': crypto.randomUUID(),
    'bx-ua': qwenHeaders['bx-ua'],
    'bx-umidtoken': qwenHeaders['bx-umidtoken'],
    'bx-v': qwenHeaders['bx-v'],
  };
}

async function qwenFetchWithDebug(
  url: string,
  method: string,
  headers: Record<string, string>,
  category: 'chat' | 'session-create' | 'session-delete' | 'models' | 'settings' | 'auth' | 'other',
  body?: unknown,
): Promise<{ response: Response; debugId: string }> {
  const entry = createNetworkEntry({ url, method, headers, body, category });
  const debugId = entry.id;
  const { controller, cleanup } = createFetchTimeout();
  let response: Response;
  try {
    const fetchOpts: RequestInit & { signal?: AbortSignal } = { method, headers, signal: controller.signal };
    if (body !== undefined) fetchOpts.body = JSON.stringify(body);
    response = await fetch(url, fetchOpts);
  } finally {
    cleanup();
  }
  recordResponse(debugId, response);
  return { response, debugId };
}

async function postQwenSettings(
  email: string | undefined,
  payload: Record<string, unknown>,
): Promise<{ response: Response; debugId: string }> {
  const { headers } = await getQwenHeaders(email);
  return qwenFetchWithDebug(QWEN_SETTINGS_URL, 'POST', makeQwenSettingsHeaders(headers), 'settings', payload);
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;
let nativeToolsDisabled = false;
let disablingNativeToolsInProgress: Promise<void> | null = null;
let personalizationDisabled = false;
let disablingPersonalizationInProgress: Promise<void> | null = null;

export async function disableNativeTools(): Promise<void> {
  if (nativeToolsDisabled) return;
  if (disablingNativeToolsInProgress) {
    await disablingNativeToolsInProgress;
    return;
  }
  disablingNativeToolsInProgress = (async () => {
    let settingsDebugId: string | null = null;
    try {
      const payload = {
        tools_enabled: {
          web_extractor: false,
          web_search_image: false,
          web_search: false,
          image_gen_tool: false,
          code_interpreter: false,
          history_retriever: false,
          image_edit_tool: false,
          bio: false,
          image_zoom_in_tool: false,
          image_search: false,
        },
        memory: { enable_memory: false, enable_history_memory: false },
        mcp: { 'code-interpreter': false, 'fire-crawl': false, amap: false, 'image-generation': false },
      };
      const { response, debugId } = await postQwenSettings(undefined, payload);
      settingsDebugId = debugId;
      if (!response.ok) {
        const text = await response.text();
        console.error(`[Qwen] Failed to disable native tools: ${response.status} - ${text}`);
        completeEntry(settingsDebugId);
      } else {
        nativeToolsDisabled = true;
        completeEntry(settingsDebugId);
      }
    } catch (err: any) {
      if (settingsDebugId) errorEntry(settingsDebugId, err.message);
      console.error(`[Qwen] Error disabling native tools: ${err.message}`);
    } finally {
      disablingNativeToolsInProgress = null;
    }
  })();
  return disablingNativeToolsInProgress;
}

export async function disablePersonalization(): Promise<void> {
  if (personalizationDisabled) return;
  if (disablingPersonalizationInProgress) {
    await disablingPersonalizationInProgress;
    return;
  }
  disablingPersonalizationInProgress = (async () => {
    const emails = getAllAccountEmails();
    const accountsToProcess = emails.length > 0 ? emails : ['primary'];
    for (const email of accountsToProcess) {
      let settingsDebugId: string | null = null;
      try {
        const payload = {
          memory: { enable_memory: false, enable_history_memory: false, memory_version_reminder: false },
          mcp: { 'code-interpreter': false, 'fire-crawl': false, amap: false, 'image-generation': false },
        };
        const { response, debugId } = await postQwenSettings(email, payload);
        settingsDebugId = debugId;
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
  try {
    return await disablingPersonalizationInProgress;
  } finally {
    disablingPersonalizationInProgress = null;
  }
}

let customInstructionApplied = false;
let applyingCustomInstructionInProgress: Promise<void> | null = null;

export async function setCustomInstruction(instruction: string): Promise<void> {
  if (!instruction || instruction.trim().length === 0) return;
  if (customInstructionApplied) return;
  if (applyingCustomInstructionInProgress) {
    await applyingCustomInstructionInProgress;
    return;
  }
  applyingCustomInstructionInProgress = (async () => {
    const emails = getAllAccountEmails();
    const accountsToProcess = emails.length > 0 ? emails : ['primary'];
    let successCount = 0;
    for (const email of accountsToProcess) {
      let settingsDebugId: string | null = null;
      try {
        const payload = {
          personalization: {
            instruction: instruction,
            enable_for_new_chat: true,
          },
        };
        const { response, debugId } = await postQwenSettings(email, payload);
        settingsDebugId = debugId;
        if (!response.ok) {
          const text = await response.text();
          console.error(`[Qwen] Failed to set custom instruction for ${email}: ${response.status} - ${text}`);
        } else {
          successCount++;
        }
        completeEntry(settingsDebugId);
      } catch (err: any) {
        if (settingsDebugId) errorEntry(settingsDebugId, err.message);
        console.error(`[Qwen] Error setting custom instruction for ${email}: ${err.message}`);
      }
    }
    customInstructionApplied = successCount > 0;
    if (!customInstructionApplied) {
      console.error('[Qwen] Custom instruction failed for all accounts — will retry on next call');
    }
  })();
  try {
    return await applyingCustomInstructionInProgress;
  } finally {
    applyingCustomInstructionInProgress = null;
  }
}

export async function configureAccount(email: string, instruction?: string): Promise<void> {
  let settingsDebugId: string | null = null;
  try {
    const payload: Record<string, any> = {
      tools_enabled: {
        web_extractor: false,
        web_search_image: false,
        web_search: false,
        image_gen_tool: false,
        code_interpreter: false,
        history_retriever: false,
        image_edit_tool: false,
        bio: false,
        image_zoom_in_tool: false,
        image_search: false,
      },
      memory: { enable_memory: false, enable_history_memory: false },
      mcp: { 'code-interpreter': false, 'fire-crawl': false, amap: false, 'image-generation': false },
    };
    if (instruction && instruction.trim().length > 0) {
      payload.personalization = { instruction, enable_for_new_chat: true };
    } else if (!instruction) {
      const useCustom = config.get('USE_CUSTOM_INSTRUCTION') === 'true';
      const resolved = useCustom ? config.get('CUSTOM_INSTRUCTION') : DEFAULT_SYSTEM_PROMPT;
      if (resolved && resolved.trim().length > 0) {
        payload.personalization = { instruction: resolved, enable_for_new_chat: true };
      }
    }
    const { response, debugId } = await postQwenSettings(email, payload);
    settingsDebugId = debugId;
    if (response.ok) {
      logStore.log('info', 'account', `Account ${email} configured (tools off, memory off${instruction ? ', instruction set' : ''})`);
    } else {
      const text = await response.text();
      console.error(`[Qwen] Failed to configure ${email}: ${response.status} - ${text}`);
    }
    completeEntry(settingsDebugId);
  } catch (err: any) {
    if (settingsDebugId) errorEntry(settingsDebugId, err.message);
    console.error(`[Qwen] Error configuring ${email}: ${err.message}`);
  }
}

export async function deleteAllChats(email: string): Promise<void> {
  let debugId: string | null = null;
  try {
    const { headers } = await getQwenHeaders(email);
    const reqHeaders = makeQwenSettingsHeaders(headers, false);
    const { response, debugId: fetchDebugId } = await qwenFetchWithDebug(QWEN_CHATS_URL, 'DELETE', reqHeaders, 'settings');
    debugId = fetchDebugId;
    const body = await response.json();
    if (response.ok && body?.success !== false) {
      logStore.log('info', 'account', `All chats deleted for ${email}`);
    } else {
      const errMsg = body?.message || body?.error || JSON.stringify(body);
      console.error(`[Qwen] Failed to delete chats for ${email}: ${response.status} - ${errMsg}`);
      throw new Error(`Delete chats failed: ${errMsg}`);
    }
    completeEntry(debugId);
  } catch (err: any) {
    if (debugId) errorEntry(debugId, err.message);
    console.error(`[Qwen] Error deleting chats for ${email}: ${err.message}`);
    throw err;
  }
}

export async function fetchQwenModels(): Promise<any[]> {
  const now = Date.now();
  const cacheTtl = config.getInt('MODELS_CACHE_TTL_MS', 3600000);
  if (cachedModels && now - lastModelsFetch < cacheTtl) {
    return cachedModels;
  }
  const { cookie, userAgent, bxV, email: resolvedEmail } = await getBasicHeaders();
  // getBasicHeaders() internally calls pickAccount() which increments inFlight.
  // This is a non-session model-fetch, so decrement immediately to prevent leak.
  if (resolvedEmail) decrementInFlight(resolvedEmail);
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let modelsDebugId: string | null = null;
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
      const modelsHeaders: Record<string, string> = {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'pt-BR,pt;q=0.9',
        cookie: cookie,
        referer: 'https://chat.qwen.ai/',
        'user-agent': userAgent,
        'x-request-id': crypto.randomUUID(),
        'bx-v': bxV,
        timezone: cachedTimezone,
        source: 'web',
      };
      const modelsDebugEntry = createNetworkEntry({
        url: QWEN_MODELS_URL,
        method: 'GET',
        headers: modelsHeaders,
        category: 'models',
      });
      modelsDebugId = modelsDebugEntry.id;
      const { controller, cleanup } = createFetchTimeout();
      let response: Response;
      try {
        response = await fetch(QWEN_MODELS_URL, { headers: modelsHeaders, signal: controller.signal });
      } finally {
        cleanup();
      }
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
        const specs = typedSpecs[id] ||
          typedSpecs[id.replace(/-no-thinking$/, '')] || { max_context: 1000000, max_output: 65536, modalities: ['text'] };
        return {
          id: m.id,
          object: 'model',
          created: m.info?.created_at || Math.floor(Date.now() / 1000),
          owned_by: m.owned_by || 'qwen',
          context_window: specs.max_context,
          max_output_tokens: specs.max_output,
          modalities: specs.modalities,
        };
      });
      const extendedModels = [...models];
      for (const m of models) {
        extendedModels.push({ ...m, id: `${m.id}-no-thinking` });
      }
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
