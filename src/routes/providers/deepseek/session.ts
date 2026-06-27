/*
 * File: providers/deepseek/session.ts
 * DeepSeek chat session management.
 * Handles user info retrieval and chat session creation/caching.
 */

import { DEEPSEEK_BASE_URL } from './spoofing.ts';

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
 */
export async function getOrCreateChatSession(bearerToken: string): Promise<DeepSeekChatSession | null> {
  // Check cache
  var cached = sessionCache.get(bearerToken);
  if (cached && Date.now() - cached.timestamp < SESSION_TTL) {
    return cached.session;
  }

  try {
    var res = await fetch(DEEPSEEK_BASE_URL + '/api/v0/chat_session/create', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + bearerToken,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    var body: any = await res.json();
    var chatData = body.data?.chat_session || body.data || body;
    // The response can be nested: { data: { chat_session: { id, ... } } }
    // or flat: { chat_session: { id, ... } }
    if (chatData && chatData.id === undefined && chatData.chat_session) {
      chatData = chatData.chat_session;
    }

    var session: DeepSeekChatSession = {
      id: chatData.id || chatData.chat_session_id || '',
      seq_id: chatData.seq_id || 0,
      agent: chatData.agent || '',
      model_type: chatData.model_type || 'default',
      ttl_seconds: body.data?.ttl_seconds || chatData.ttl_seconds || 259200,
    };

    if (!session.id) return null;

    sessionCache.set(bearerToken, { session, timestamp: Date.now() });
    return session;
  } catch {
    return null;
  }
}

/**
 * Clear the session cache for a token (e.g., on auth failure).
 */
export function clearSessionCache(bearerToken: string): void {
  sessionCache.delete(bearerToken);
}
