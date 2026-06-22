import modelSpecs from '../models.json' with { type: 'json' };
import type { ModelSpec } from '../types/openai.ts';
import { decrementInFlight, getAllAccountEmails } from './auth.ts';
import { config } from './configService.ts';
import { DEFAULT_SYSTEM_PROMPT } from './defaultSystemPrompt.ts';
import { logStore } from './logStore.ts';
import { completeEntry, errorEntry } from './networkDebug.ts';
import { getBasicHeaders, getQwenHeaders, performBrowserFetch } from './playwright.ts';
import { QWEN_CHATS_URL, QWEN_MODELS_URL, QWEN_SETTINGS_URL } from './qwen.ts';

export { DEFAULT_SYSTEM_PROMPT };

async function postQwenSettings(
  email: string | undefined,
  payload: Record<string, unknown>,
): Promise<{ response: Response; debugId: string }> {
  // Ensure browser context exists
  await getQwenHeaders(email);
  // Route through real browser (Chrome TLS, automatic headers, baxia)
  const result = await performBrowserFetch(email!, QWEN_SETTINGS_URL, {
    method: 'POST',
    body: JSON.stringify(payload),
    timeout: 30000,
  });
  const mockResponse = new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  return { response: mockResponse, debugId: 'browser-' + Date.now() };
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;
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
  try {
    await getQwenHeaders(email);
    const result = await performBrowserFetch(email, QWEN_CHATS_URL, {
      method: 'DELETE',
      timeout: 30000,
    });
    if (result.ok) {
      const body = JSON.parse(result.body);
      if (body?.success !== false) {
        logStore.log('info', 'account', `All chats deleted for ${email}`);
      } else {
        throw new Error(`Delete chats failed: ${body?.message || body?.error || JSON.stringify(body)}`);
      }
    } else {
      const errMsg = result.body || `HTTP ${result.status}`;
      console.error(`[Qwen] Failed to delete chats for ${email}: ${result.status} - ${errMsg}`);
      throw new Error(`Delete chats failed: ${errMsg}`);
    }
  } catch (err: any) {
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

  const { email: resolvedEmail } = await getBasicHeaders();
  if (resolvedEmail) decrementInFlight(resolvedEmail);

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));

      const result = await performBrowserFetch(resolvedEmail!, QWEN_MODELS_URL, {
        method: 'GET',
        timeout: 30000,
      });

      if (!result.ok) throw new Error(`Failed to fetch models from Qwen: ${result.status} ${result.statusText}`);

      const json = JSON.parse(result.body);
      if (!json.data || !Array.isArray(json.data)) {
        logStore.log('debug', 'qwen', `[Qwen] fetchQwenModels: response missing data array, returning cached or empty`);
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
      return extendedModels;
    } catch (err: any) {
      lastErr = err;
    }
  }

  console.error(`[Qwen] fetchQwenModels failed after 3 attempts:`, lastErr?.message);
  return cachedModels || [];
}
