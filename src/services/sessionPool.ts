import crypto from 'node:crypto';
import { getBasicHeaders, type BasicHeaders } from './playwright.ts';
import { pickAccount, decrementInFlight, incrementTotalRequests, getAccountByEmail, throttleAccount, getAllAccountEmails } from './auth.ts';
import { createNetworkEntry, recordResponse, completeEntry, errorEntry } from './networkDebug.ts';
import { logStore } from './logStore.js';
import { config } from './configService.ts';
import { QWEN_API_BASE } from './qwen.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
  /** Which account email this session is bound to */
  accountEmail?: string;
  /** Timestamp when this entry was created (for prewarm staleness tracking) */
  createdAt?: number;
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

  // Pre-warming pool
  private prewarmedSessions = new Map<string, PoolEntry[]>();
  private readonly MAX_PREWARMED = parseInt((config as any).get('SESSION_PREWARM_POOL_SIZE', '2'), 10);
  private readonly PREWARM_MAX_AGE_MS = 5 * 60 * 1000;
  private replenishPending = new Set<string>();

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      return;
    }
  }

  /**
   * Pre-warm sessions for the given emails.
   * Creates up to MAX_PREWARMED empty chats per account so acquire() can skip the HTTP round-trip.
   */
  async prewarmSessions(emails: string[]): Promise<void> {
    const tasks = emails.map(email => this.replenishPool(email));
    await Promise.allSettled(tasks);
  }

  /**
   * Acquire a fresh session. If email is provided, use that specific account.
   * Otherwise, pick the best available account (round-robin, non-throttled).
   * Checks pre-warmed pool first before creating a new session.
   */
  async acquire(email?: string): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      return { chatId: mockId, parentId: null, inUse: true, accountEmail: 'mock@test' };
    }

    const maxAttempts = email ? 1 : Math.max(1, getAllAccountEmails().length);
    let lastErr: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const resolvedEmail = email || (await pickAccount())?.email;

      // Check pre-warmed pool first
      const prewarmed = this.getPrewarmedSession(resolvedEmail);
      if (prewarmed) {
        this.activeSessions.add(prewarmed.chatId);
        this.activeCount++;
        logStore.log('info', 'pool', 'Session acquired (prewarmed)' + (prewarmed.accountEmail ? ': ' + prewarmed.accountEmail.split('@')[0] : ''));
        // Replenish pool in background (fire-and-forget)
        this.replenishPool(resolvedEmail!).catch(() => {});
        return prewarmed;
      }

      try {
        // Fetch headers once, pass to createSessionWithHeaders (no duplicate getBasicHeaders call)
        const headers = await getBasicHeaders(resolvedEmail);
        const chatId = await this.createSessionWithHeaders(resolvedEmail, headers);
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
        const idx = this.waiting.findIndex(w => w.timer === timer);
        if (idx >= 0) this.waiting.splice(idx, 1);
        reject(new SessionPoolWaitTimeoutError(this.WAIT_TIMEOUT_MS));
      }, this.WAIT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.waiting.push({ resolve, reject, timer });
    });
  }

  async release(chatId: string, _newParentId: string | null, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string, isSuccess: boolean = true): Promise<void> {
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

      // Try pre-warmed pool first for the waiter
      const prewarmed = this.getPrewarmedSession(waiterEmail);
      if (prewarmed) {
        prewarmed.parentId = _newParentId;
        this.activeSessions.add(prewarmed.chatId);
        this.activeCount++;
        waiter.resolve(prewarmed);
      } else {
        // Fetch headers once, create session with pre-fetched headers (no duplicate getBasicHeaders call)
        (async () => {
          try {
            const headers = await getBasicHeaders(waiterEmail);
            const id = await this.createSessionWithHeaders(waiterEmail, headers);
            this.activeSessions.add(id);
            this.activeCount++;
            waiter.resolve({ chatId: id, parentId: _newParentId, inUse: true, cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent }, accountEmail: headers.email || waiterEmail });
          } catch (err: any) {
            console.error('[SessionPool] Failed to create session for waiter:', err.message);
            // pickAccount() incremented inFlight — decrement on failure to prevent leak
            if (waiterEmail) decrementInFlight(waiterEmail);
            waiter.reject(err);
          }
        })();
      }
    }
    this.activeSessions.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;
    const existingTimer = this.releaseTimers.get(chatId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.deleteSession(chatId, cachedHeaders, accountEmail);
      this.releaseTimers.delete(chatId);
    }, 60_000);
    if (typeof timer.unref === 'function') timer.unref();
    this.releaseTimers.set(chatId, timer);

    // Trigger pre-warm pool replenishment in background (fire-and-forget)
    if (accountEmail) {
      this.replenishPool(accountEmail).catch(() => {});
    }

    logStore.log('info', 'pool', 'Session released' + (accountEmail ? ': ' + accountEmail.split('@')[0] : ''));
  }

  async deleteSession(chatId: string, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (config.get('DELETE_SESSION', 'true') === 'false') {
      return;
    }

    let cookie: string, userAgent: string;
    try {
      const headers = cachedHeaders || await getBasicHeaders(accountEmail);
      cookie = headers.cookie;
      userAgent = headers.userAgent;
    } catch (err: any) {
      console.error('[SessionPool] Failed to get headers for session deletion:', err);
      return;
    }
    const requestId = crypto.randomUUID();
    const debugEntry = createNetworkEntry({
      url: `${QWEN_API_BASE}/api/v2/chats/${chatId}`,
      method: 'DELETE',
      headers: { cookie, 'user-agent': userAgent, 'x-request-id': requestId },
      category: 'session-delete',
      accountEmail: accountEmail,
    });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${QWEN_API_BASE}/api/v2/chats/${chatId}`, {
        method: 'DELETE',
        signal: controller.signal,
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'cookie': cookie,
          'referer': `${QWEN_API_BASE}/`,
          'user-agent': userAgent,
          'x-request-id': requestId,
          'source': 'web',
        },
      });
      clearTimeout(timeout);
      recordResponse(debugEntry.id, response);
      if (response.ok) {
        completeEntry(debugEntry.id);
      } else {
        errorEntry(debugEntry.id, `Delete returned ${response.status}`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        errorEntry(debugEntry.id, 'Delete request aborted (timeout)');
        console.warn(`[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
        errorEntry(debugEntry.id, err.message);
        console.warn(`[SessionPool] Delete failed for ${chatId.substring(0, 8)}...: ${err.message}`);
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
    const { cookie, userAgent, bxUmidtoken, bxUa, bxV } = headers;
    const requestId = crypto.randomUUID();

    const acct = email ? getAccountByEmail(email) : null;
    const bearerToken = acct?.state?.token;

    const fetchHeaders: Record<string, string> = {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': requestId,
      'source': 'web',
      'bx-umidtoken': bxUmidtoken,
      'bx-ua': bxUa,
      'bx-v': bxV,
    };
    if (bearerToken) {
      fetchHeaders['authorization'] = `Bearer ${bearerToken}`;
    }

    const debugEntry = createNetworkEntry({
      url: `${QWEN_API_BASE}/api/v2/chats/new`,
      method: 'POST',
      headers: fetchHeaders,
      body: {},
      category: 'session-create',
      accountEmail: email,
    });

    let response: Response;
    try {
      response = await fetch(`${QWEN_API_BASE}/api/v2/chats/new`, {
        method: 'POST',
        headers: fetchHeaders,
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30000),
      });
      recordResponse(debugEntry.id, response);
    } catch (err) {
      errorEntry(debugEntry.id, err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (!response.ok) {
      errorEntry(debugEntry.id, `Chats/new returned ${response.status}`);
      throw new Error(`Chats/new returned ${response.status}`);
    }
    const json = await response.json();
    if (!json.data?.id) {
      const message = formatQwenEnvelopeError(json);
      errorEntry(debugEntry.id, `Chats/new returned no id: ${message}`);
      throw new Error(`Chats/new returned no id: ${message}`);
    }
    completeEntry(debugEntry.id);
    return json.data.id;
  }

  /**
   * Convenience wrapper: fetches headers then delegates to createSessionWithHeaders.
   */
  private async createSession(email?: string): Promise<string> {
    const headers = await getBasicHeaders(email);
    return this.createSessionWithHeaders(email || '', headers);
  }

  /**
   * Extract a pre-warmed session from the pool for the given email.
   * Removes stale entries and returns the first available non-stale entry (marked inUse).
   * Returns null if no pre-warmed session is available.
   */
  private getPrewarmedSession(email: string | undefined): PoolEntry | null {
    if (!email) return null;
    const pool = this.prewarmedSessions.get(email);
    if (!pool || pool.length === 0) return null;

    const now = Date.now();
    // Prune stale entries
    const fresh = pool.filter(e => (now - (e.createdAt || 0)) < this.PREWARM_MAX_AGE_MS);
    this.prewarmedSessions.set(email, fresh);

    // Find first available (non-inUse) entry
    const idx = fresh.findIndex(e => !e.inUse);
    if (idx === -1) return null;

    const entry = fresh[idx];
    entry.inUse = true;
    fresh.splice(idx, 1);
    return entry;
  }

  /**
   * Replenish the pre-warm pool for a given email.
   * Deduplicates concurrent calls. Creates sessions up to MAX_PREWARMED.
   * Fire-and-forget: errors are silently swallowed.
   */
  private async replenishPool(email: string): Promise<void> {
    if (!email) return;
    if (this.replenishPending.has(email)) return;
    this.replenishPending.add(email);

    try {
      const pool = this.prewarmedSessions.get(email) || [];
      const now = Date.now();

      // Remove stale entries
      const fresh = pool.filter(e => (now - (e.createdAt || 0)) < this.PREWARM_MAX_AGE_MS);
      this.prewarmedSessions.set(email, fresh);

      // Count available (non-inUse) entries
      const available = fresh.filter(e => !e.inUse).length;
      const toCreate = this.MAX_PREWARMED - available;
      if (toCreate <= 0) return;

      // Fetch headers once for all parallel session creations
      const headers = await getBasicHeaders(email);

      // Create sessions in parallel
      const results = await Promise.allSettled(
        Array.from({ length: toCreate }, () => this.createSessionWithHeaders(email, headers))
      );

      const newEntries: PoolEntry[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          newEntries.push({
            chatId: result.value,
            parentId: null,
            inUse: false,
            cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
            accountEmail: headers.email || email,
            createdAt: Date.now(),
          });
        }
      }

      if (newEntries.length > 0) {
        fresh.push(...newEntries);
        this.prewarmedSessions.set(email, fresh);
        logStore.log('info', 'pool', `Pre-warmed ${newEntries.length} session(s) for ${email.split('@')[0]}`);
      }
    } catch {
      // Pre-warming is best-effort; silently fail
    } finally {
      this.replenishPending.delete(email);
    }
  }
}

export const sessionPool = new SessionPool();
