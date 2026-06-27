/*
 * File: providers/deepseek/session.ts
 * DeepSeek chat session management.
 * Handles user info retrieval and chat session creation/caching.
 */

import { logStore } from '../../../services/logStore.ts';
import { buildDeepSeekHeaders, createDeepSeekContext, DEEPSEEK_BASE_URL } from './spoofing.ts';
import { getPowResponseHeader } from './pow.ts';

export interface DeepSeekUser {
  id: string;
  token: string;
  email: string;
}

export interface DeepSeekChatSession {
  id: string;
  seq_id: number;
  agent: string;
  model_type: string;
  ttl_seconds: number;
}

// ponytail: simple in-memory session cache per bearer token
interface SessionCacheEntry {
  session: DeepSeekChatSession;
  timestamp: number;
}
const sessionCache = new Map<string, SessionCacheEntry>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get current user info from DeepSeek.
 * Hits GET /api/v0/users/current and extracts the Bearer token and user details.
 */
export async function getCurrentUser(bearerToken: string): Promise<DeepSeekUser | null> {
  try {
    var res = await fetch(DEEPSEEK_BASE_URL + '/api/v0/users/current', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + bearerToken,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    var body: any = await res.json();
    var bizData = body.data?.biz_data || body.data || body;
    var user = bizData.user || bizData;
    var token = bizData.token || user.token || null;

    return {
      id: user.id || user.uid || '',
      token: token || bearerToken,
      email: user.email || user.name || '',
    };
  } catch {
    return null;
  }
}

/**
 * Get or create a chat session for this Bearer token.
 * Caches for 30 minutes to avoid creating new sessions on every request.
 * Uses spoofed browser headers + optional PoW to match what the DeepSeek web client sends.
 */
export async function getOrCreateChatSession(bearerToken: string): Promise<DeepSeekChatSession | null> {
  // Check cache
  var cached = sessionCache.get(bearerToken);
  if (cached && Date.now() - cached.timestamp < SESSION_TTL) {
    return cached.session;
  }

  try {
    // Build spoofed browser context — matches pipeline.ts flow
    var ctx = createDeepSeekContext(bearerToken);

    // Try to solve PoW for the session creation endpoint
    var powHeader: string | null = null;
    try {
      powHeader = await getPowResponseHeader('session', bearerToken, '/api/v0/chat_session/create');
    } catch {
      // Proceed without PoW — matches pipeline.ts:84 pattern
    }

    // Build full spoofed browser headers (device ID, cookies, fingerprint)
    var baseHeaders = buildDeepSeekHeaders(ctx, {
      powResponse: powHeader || undefined,
      hifLeim: ctx.hifLeim,
      dsSessionId: '',
    }) as unknown as Record<string, string>;
    // Session create is JSON, not SSE
    baseHeaders['accept'] = 'application/json';

    var res = await fetch(DEEPSEEK_BASE_URL + '/api/v0/chat_session/create', {
      method: 'POST',
      headers: baseHeaders,
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    var body: any;
    if (!res.ok) {
      var errText = await res.text().catch(function () {
        return 'unknown';
      });
      logStore.log('warn', 'deepseek-session', 'POST /api/v0/chat_session/create failed: ' + res.status + ' ' + errText.slice(0, 500));
      return null;
    }

    body = await res.json().catch(function () {
      return null;
    });
    if (!body) {
      logStore.log('warn', 'deepseek-session', 'POST /api/v0/chat_session/create: empty/unparseable body');
      return null;
    }
    if (body.code) {
      logStore.log('warn', 'deepseek-session', 'POST /api/v0/chat_session/create error: ' + JSON.stringify(body).slice(0, 500));
    }

    // Response formats observed:
    //   { code:0, msg:"", data: { biz_data: { chat_session: { id, seq_id, ... }, ttl_seconds }, ... } }
    //   { data: { chat_session: { id, ... } } }
    //   { chat_session: { id, ... } }
    //   { id, ... }
    var chatData = body.data?.biz_data?.chat_session || body.data?.chat_session || body.data?.biz_data || body.data || body;
    if (chatData && chatData.id === undefined && chatData.chat_session) {
      chatData = chatData.chat_session;
    }

    var session: DeepSeekChatSession = {
      id: chatData.id || chatData.chat_session_id || '',
      seq_id: chatData.seq_id || 0,
      agent: chatData.agent || '',
      model_type: chatData.model_type || 'default',
      ttl_seconds: body.data?.biz_data?.ttl_seconds || body.data?.ttl_seconds || chatData.ttl_seconds || 259200,
    };

    if (!session.id) {
      logStore.log(
        'warn',
        'deepseek-session',
        'POST /api/v0/chat_session/create: no session id in response — token may be expired or invalid',
      );
      return null;
    }

    sessionCache.set(bearerToken, { session, timestamp: Date.now() });
    return session;
  } catch (err: any) {
    logStore.log('error', 'deepseek-session', 'getOrCreateChatSession exception: ' + (err?.message || err));
    return null;
  }
}

/**
 * Clear the session cache for a token (e.g., on auth failure).
 */
export function clearSessionCache(bearerToken: string): void {
  sessionCache.delete(bearerToken);
}
