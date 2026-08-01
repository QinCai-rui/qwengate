/**
 * Qwen entitlement quota service.
 * Fetches per-model + per-feature daily quota via
 * POST /api/v2/users/user/entitlement_quota — the same endpoint the
 * chat.qwen.ai SPA uses (discovered from main.js bundle).
 */

import type { EquityQuota } from '../types/auth.ts';
import { getTokenWithAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';

const QUOTA_URL = `${QWEN_API_BASE}/api/v2/users/user/entitlement_quota`;

/** Feature list — exact array the SPA passes (from main.js `rn`). */
export const QUOTA_FEATURES = [
  'model',
  'thinking',
  'search',
  't2v',
  't2i',
  'deep_research_deep_research',
  'artifacts_deploy_artifacts',
  'artifacts_deploy_web_dev',
  'artifacts_deploy_deep_research',
  'audio_chat_AudioOnly',
  'audio_chat_AudioAndVideo',
  'deep_research_aipodcast',
  'code',
  'image_edit',
  'deep_research_deep_research_advanced',
];

export interface QuotaResult {
  model: Record<string, EquityQuota>;
  features: Record<string, EquityQuota>;
  userTier: string | null;
}

/** Fetch entitlement quota for an account. Returns null on any failure. */
export async function fetchAccountQuota(email: string): Promise<QuotaResult | null> {
  try {
    const tokenInfo = await getTokenWithAccount(email);
    if (!tokenInfo) {
      logStore.log('debug', 'quota', `[Quota] No token for ${email}`);
      return null;
    }
    const response = await browserlessFetch(QUOTA_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        source: 'web',
        cookie: `token=${tokenInfo.token}`,
        origin: QWEN_API_BASE,
        referer: `${QWEN_API_BASE}/`,
      },
      body: JSON.stringify({ features: QUOTA_FEATURES }),
      accountEmail: email,
    });
    if (!response.ok) {
      logStore.log('debug', 'quota', `[Quota] ${email}: HTTP ${response.status}`);
      return null;
    }
    const json = JSON.parse(await response.text());
    if (!json?.success || !json?.data) {
      logStore.log('debug', 'quota', `[Quota] ${email}: success=false → ${JSON.stringify(json?.data || {}).slice(0, 200)}`);
      return null;
    }
    const data = json.data;
    const result: QuotaResult = { model: {}, features: {}, userTier: data.user_tier || null };
    if (data.model && typeof data.model === 'object') {
      for (const [modelId, q] of Object.entries(data.model)) {
        const quota = q as EquityQuota;
        if (quota && typeof quota === 'object' && 'times_left' in quota) {
          result.model[modelId] = quota;
        }
      }
    }
    for (const [feat, q] of Object.entries(data)) {
      if (feat === 'model' || feat === 'user_tier') continue;
      const quota = q as EquityQuota;
      if (quota && typeof quota === 'object' && 'times_left' in quota) {
        result.features[feat] = quota;
      }
    }
    return result;
  } catch (err: any) {
    logStore.log('debug', 'quota', `[Quota] ${email} error: ${err?.message}`);
    return null;
  }
}
