import crypto from 'node:crypto';
import { decrementInFlight, getAccountByEmail, getAllAccountEmails, incrementTotalRequests, pickAccount, throttleAccount } from './auth.ts';
import { config } from './configService.ts';
import { logStore } from './logStore.ts';
import { type BasicHeaders, getBasicHeaders, performBrowserFetch } from './playwright.ts';
import { QWEN_API_BASE } from './qwen.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
  /** Which account email this session is bound to */
  accountEmail?: string;
}

export class SessionPoolQueueFullError extends Error {
  constructor(current: number, max: number) {
    super(`Session pool queue full (${current}/${max}). Try again later.`);
    this.name = 'SessionPoolQueueFullError';
  }
}

export class SessionPoolWaitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Session pool wait timed out after ${timeoutMs}ms`);
    this.name = 'SessionPoolWaitTimeoutError';
  }
}

interface WaiterEntry {
  resolve: (entry: PoolEntry) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function formatQwenEnvelopeError(json: any): string {
  const code = json?.data?.code || json?.code || 'unknown';
  const details = json?.data?.details || json?.details || json?.message || '';
  return details ? `${code}: ${details}` : String(code);
}

export class SessionPool {
  private waiting: Array<WaiterEntry> = [];
  private activeSessions = new Set<string>();
  private activeCount = 0;
  private readonly MAX_WAITING = 10;
  private readonly WAIT_TIMEOUT_MS = 60_000;
  private releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      return;
    }
  }

  /**
   * Acquire a fresh session. If email is provided, use that specific account.
   * Otherwise, pick the best available account (round-robin, non-throttled).
   */
  async acquire(email?: string): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      return { chatId: mockId, parentId: null, inUse: true, accountEmail: 'mock@test' };
    }

    const maxAttempts = email ? 1 : Math.max(1, getAllAccountEmails().length);
    let lastErr: unknown;
    const ACQUIRE_TIMEOUT = 30_000; // ponytail: overall timeout to prevent hanging session creation

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const resolvedEmail = email || (await pickAccount())?.email;

      try {
        // Fetch headers once, pass to createSessionWithHeaders (no duplicate getBasicHeaders call)
        const result = await Promise.race([
          (async () => {
            const headers = await getBasicHeaders(resolvedEmail);
            const chatId = await this.createSessionWithHeaders(resolvedEmail, headers);
            return { headers, chatId };
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Session acquire timed out for ${resolvedEmail || '?'} after ${ACQUIRE_TIMEOUT}ms`)),
              ACQUIRE_TIMEOUT,
            ),
          ),
        ]);
        const { headers, chatId } = result;
        const entry: PoolEntry = {
          chatId,
          parentId: null,
          inUse: true,
          cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
          accountEmail: headers.email || resolvedEmail,
        };
        this.activeSessions.add(chatId);
        this.activeCount++;
        logStore.log('info', 'pool', 'Session acquired' + (entry.accountEmail ? ': ' + entry.accountEmail.split('@')[0] : ''));
        return entry;
      } catch (err: any) {
        lastErr = err;
        if (resolvedEmail) {
          decrementInFlight(resolvedEmail);
          if (!email && /pending activation|Bad_Request|Chats\/new returned no id/i.test(err?.message || '')) {
            throttleAccount(resolvedEmail, 30 * 60 * 1000);
            logStore.log('warn', 'pool', `Skipping account ${resolvedEmail}: ${err.message}`);
            continue;
          }
        }
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('Failed to acquire session');
  }

  getWaitingCount(): number {
    return this.waiting.length;
  }

  isQueueFull(): boolean {
    return this.waiting.length >= this.MAX_WAITING;
  }

  /**
   * Enqueue a waiter with timeout. Throws SessionPoolQueueFullError if queue is at capacity,
   * or SessionPoolWaitTimeoutError if wait exceeds WAIT_TIMEOUT_MS.
   */
  enqueueWaiter(): Promise<PoolEntry> {
    if (this.isQueueFull()) {
      throw new SessionPoolQueueFullError(this.waiting.length, this.MAX_WAITING);
    }
    return new Promise<PoolEntry>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiting.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiting.splice(idx, 1);
        reject(new SessionPoolWaitTimeoutError(this.WAIT_TIMEOUT_MS));
      }, this.WAIT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.waiting.push({ resolve, reject, timer });
    });
  }

  async release(
    chatId: string,
    _newParentId: string | null,
    cachedHeaders?: { cookie: string; userAgent: string },
    accountEmail?: string,
    isSuccess: boolean = true,
  ): Promise<void> {
    // Idempotency guard: if chatId not tracked as active, this session was already released.
    // Prevents double-release from competing cleanup paths (setTimeout + finally).
    if (!this.activeSessions.has(chatId)) {
      return;
    }

    // Track completed request — decrement in-flight, bump total count
    // Only count successful completions toward totalRequests
    if (accountEmail) {
      decrementInFlight(accountEmail);
      if (isSuccess) {
        incrementTotalRequests(accountEmail);
      }
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      const waiterEmail = accountEmail || (await pickAccount())?.email;

      // Fetch headers once, create session with pre-fetched headers (no duplicate getBasicHeaders call)
      (async () => {
        try {
          const headers = await getBasicHeaders(waiterEmail);
          const id = await this.createSessionWithHeaders(waiterEmail, headers);
          this.activeSessions.add(id);
          this.activeCount++;
          waiter.resolve({
            chatId: id,
            parentId: _newParentId,
            inUse: true,
            cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
            accountEmail: headers.email || waiterEmail,
          });
        } catch (err: any) {
          console.error('[SessionPool] Failed to create session for waiter:', err.message);
          // pickAccount() incremented inFlight — decrement on failure to prevent leak
          if (waiterEmail) decrementInFlight(waiterEmail);
          waiter.reject(err);
        }
      })();
    }
    this.activeSessions.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;
    const existingTimer = this.releaseTimers.get(chatId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.deleteSession(chatId, cachedHeaders, accountEmail);
      this.releaseTimers.delete(chatId);
    }, 0);
    if (typeof timer.unref === 'function') timer.unref();
    this.releaseTimers.set(chatId, timer);

    logStore.log('info', 'pool', 'Session released' + (accountEmail ? ': ' + accountEmail.split('@')[0] : ''));
  }

  async deleteSession(chatId: string, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (config.get('DELETE_SESSION', 'true') === 'false') return;

    // Ensure we have an email for browser context lookup
    let email = accountEmail;
    if (!email) {
      try {
        const headers = await getBasicHeaders();
        email = headers.email;
      } catch {
        console.error('[SessionPool] Failed to get email for session deletion');
        return;
      }
    }

    try {
      const result = await performBrowserFetch(email!, `${QWEN_API_BASE}/api/v2/chats/${chatId}`, {
        method: 'DELETE',
        timeout: 10000,
      });
      if (!result.ok) {
        logStore.log('debug', 'pool', `[SessionPool] Delete returned ${result.status} for ${chatId.substring(0, 8)}...`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        logStore.log('debug', 'pool', `[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
        logStore.log('debug', 'pool', `[SessionPool] Delete failed for ${chatId.substring(0, 8)}...: ${err.message}`);
      }
    }
  }

  getStats(): { total: number; available: number; inUse: number; waiting: number } {
    return {
      total: this.activeSessions.size,
      available: this.activeSessions.size - this.activeCount,
      inUse: this.activeCount,
      waiting: this.waiting.length,
    };
  }

  /**
   * Create a session using pre-fetched headers (avoids duplicate getBasicHeaders call).
   */
  private async createSessionWithHeaders(email: string | undefined, headers: BasicHeaders): Promise<string> {
    const acct = email ? getAccountByEmail(email) : null;

    const sessionBody = JSON.stringify({
      title: 'New Chat',
      models: [acct?.state?.token ? 'qwen3.7-plus' : 'qwen3.5-flash'],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    });

    const result = await performBrowserFetch(email!, `${QWEN_API_BASE}/api/v2/chats/new`, {
      method: 'POST',
      body: sessionBody,
      timeout: 30000,
    });

    if (!result.ok) {
      throw new Error(`Chats/new returned ${result.status}`);
    }

    const json = JSON.parse(result.body);
    if (!json.data?.id) {
      const message = formatQwenEnvelopeError(json);
      throw new Error(`Chats/new returned no id: ${message}`);
    }

    return json.data.id;
  }

  /**
   * Convenience wrapper: fetches headers then delegates to createSessionWithHeaders.
   */
  private async createSession(email?: string): Promise<string> {
    const headers = await getBasicHeaders(email);
    return this.createSessionWithHeaders(email || '', headers);
  }
}

export const sessionPool = new SessionPool();
