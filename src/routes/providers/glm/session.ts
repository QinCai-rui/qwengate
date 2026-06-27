/*
 * File: providers/glm/session.ts
 * GLM chat session and user info management.
 */

import { GLM_BASE_URL } from './spoofing.ts';
import { logStore } from '../../../services/logStore.ts';

export interface GlmUser {
  id: string;
  email: string;
  name: string;
  token: string;
}

export interface GlmChatSession {
  id: string;
  user_id: string;
  title: string;
  chat: any;
  created_at: number;
  updated_at: number;
}

// ponytail: simple in-memory cache per JWT
const sessionCache = new Map<string, { session: GlmChatSession; timestamp: number }>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get current user info from GLM (validates JWT, returns user details).
 */
export async function getCurrentUser(jwt: string): Promise<GlmUser | null> {
  try {
    const res = await fetch(`${GLM_BASE_URL}/api/v1/auths/`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logStore.log('warn', 'glm-session', `GET /api/v1/auths/ returned ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const user = data?.user || data;
    if (!user?.id) {
      logStore.log('warn', 'glm-session', 'No user ID in auth response');
      return null;
    }
    return {
      id: user.id,
      email: user.email || '',
      name: user.name || user.nickname || user.email || 'User',
      token: jwt,
    };
  } catch (err: any) {
    logStore.log('warn', 'glm-session', `getCurrentUser error: ${err.message}`);
    return null;
  }
}

/**
 * Get or create a chat session for this JWT.
 * Caches for 30 minutes.
 */
export async function getOrCreateChatSession(jwt: string, model: string): Promise<GlmChatSession | null> {
  const cached = sessionCache.get(jwt);
  if (cached && Date.now() - cached.timestamp < SESSION_TTL) {
    return cached.session;
  }

  try {
    // Get current user
    const user = await getCurrentUser(jwt);
    if (!user) return null;

    // Clean up old sessions (keep max 5)
    try {
      const sessionsRes = await fetch(`${GLM_BASE_URL}/api/v1/chats/`, {
        headers: { Authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(10000),
      });
      if (sessionsRes.ok) {
        const chatsData: any = await sessionsRes.json();
        const chats = Array.isArray(chatsData) ? chatsData : chatsData?.data || [];
        for (let i = 5; i < chats.length; i++) {
          fetch(`${GLM_BASE_URL}/api/v1/chats/${chats[i].id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${jwt}` },
          }).catch(() => {});
        }
      }
    } catch {
      // Non-critical — proceed with session creation
    }

    // Create new chat session
    const chatId = crypto.randomUUID();
    const chatBody = {
      chat: {
        id: chatId,
        title: 'OpenGate Session',
        models: [model],
        params: {},
        history: { messages: {}, currentId: null },
        tags: [],
        flags: [],
        features: [],
        mcp_servers: [],
        enable_thinking: model.includes('glm-5') || model.includes('glm-4'),
        reasoning_effort: model.includes('glm-5') ? 'max' : '',
        auto_web_search: false,
        message_version: 1,
        extra: {},
        timestamp: Date.now(),
        type: 'default',
      },
    };

    const chatRes = await fetch(`${GLM_BASE_URL}/api/v1/chats/new`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(chatBody),
      signal: AbortSignal.timeout(15000),
    });

    if (!chatRes.ok) {
      logStore.log('warn', 'glm-session', `POST /api/v1/chats/new returned ${chatRes.status}`);
      return null;
    }

    const chatData: any = await chatRes.json();
    const session: GlmChatSession = {
      id: chatData?.id || chatData?.chat?.id || chatId,
      user_id: user.id,
      title: 'OpenGate Session',
      chat: chatData?.chat || chatBody.chat,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    sessionCache.set(jwt, { session, timestamp: Date.now() });
    return session;
  } catch (err: any) {
    logStore.log('warn', 'glm-session', `getOrCreateChatSession error: ${err.message}`);
    return null;
  }
}

/**
 * Clear the session cache for a JWT.
 */
export function clearSessionCache(jwt: string): void {
  sessionCache.delete(jwt);
}
