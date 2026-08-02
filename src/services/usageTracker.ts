/**
 * Daily request usage tracker.
 *
 * Records how many requests each account sent to each model per day,
 * plus RateLimited wall hits (with wait hours) — persisted to
 * .qwen/usage.json so history survives restarts.
 *
 * Shape:
 * {
 *   "2026-08-02": {
 *     "acc@duck.com": {
 *       "qwen3.7-plus": { "requests": 12, "rateLimited": 1, "lastWaitHours": 7 },
 *       "thinking":    { "requests": 3, "rateLimited": 0 }
 *     }
 *   }
 * }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { projectPath } from '../utils/paths.ts';

type DayStats = Record<
  string, // email
  Record<
    string, // model
    { requests: number; rateLimited: number; lastWaitHours: number | null }
  >
>;

const USAGE_FILE = projectPath('.qwen', 'usage.json');
const DAY_MS = 24 * 60 * 60 * 1000;

let store: Record<string, DayStats> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dayKeyFor(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Load persisted usage from disk (called once at startup). */
export function loadUsageStore(): void {
  try {
    if (existsSync(USAGE_FILE)) {
      store = JSON.parse(readFileSync(USAGE_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[Usage] Failed to load usage store:', err);
    store = {};
  }
}

function persist(): void {
  if (saveTimer) return; // already scheduled
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(dirname(USAGE_FILE), { recursive: true });
      writeFileSync(USAGE_FILE, JSON.stringify(store, null, 2));
    } catch (err) {
      console.error('[Usage] Failed to save usage store:', err);
    }
  }, 2000); // debounce — bursts of requests write once
}

/** Record one request: account → model → day. */
export function recordUsage(email: string, model: string): void {
  const day = todayKey();
  const stats = store[day] ?? (store[day] = {});
  const acct = stats[email] ?? (stats[email] = {});
  const entry = acct[model] ?? (acct[model] = { requests: 0, rateLimited: 0, lastWaitHours: null });
  entry.requests += 1;
  persist();
}

/** Record a RateLimited wall hit — captures the wait hours as the quota signal. */
export function recordRateLimited(email: string, model: string, waitHours: number): void {
  const day = todayKey();
  const stats = store[day] ?? (store[day] = {});
  const acct = stats[email] ?? (stats[email] = {});
  const entry = acct[model] ?? (acct[model] = { requests: 0, rateLimited: 0, lastWaitHours: null });
  entry.rateLimited += 1;
  entry.lastWaitHours = waitHours;
  persist();
}

/** Prune entries older than `days` (called at startup + on reads). */
export function pruneUsage(days = 14): void {
  const cutoff = Date.now() - days * DAY_MS;
  for (const key of Object.keys(store)) {
    const ts = new Date(key + 'T00:00:00').getTime();
    if (!Number.isNaN(ts) && ts < cutoff) delete store[key];
  }
  persist();
}

/** Current in-memory view (post-prune). */
export function getUsage(): Record<string, DayStats> {
  pruneUsage(14);
  return store;
}

/** Compact summary: per account — today requests, yesterday, 7-day total, per-model split. */
export function getUsageSummary(): {
  accounts: Record<
    string,
    {
      today: number;
      yesterday: number;
      week: number;
      models: Record<string, { requests: number; rateLimited: number; lastWaitHours: number | null }>;
    }
  >;
  days: string[];
} {
  pruneUsage(14);
  const days = Object.keys(store).sort();
  const yesterday = dayKeyFor(Date.now() - DAY_MS);
  const today = todayKey();
  const weekAgo = dayKeyFor(Date.now() - 7 * DAY_MS);

  const accounts: Record<
    string,
    {
      today: number;
      yesterday: number;
      week: number;
      models: Record<string, { requests: number; rateLimited: number; lastWaitHours: number | null }>;
    }
  > = {};

  for (const [day, dayStats] of Object.entries(store)) {
    if (day < weekAgo) continue;
    for (const [email, models] of Object.entries(dayStats)) {
      const acc = accounts[email] ?? (accounts[email] = { today: 0, yesterday: 0, week: 0, models: {} });
      for (const [model, entry] of Object.entries(models)) {
        const m = acc.models[model] ?? (acc.models[model] = { requests: 0, rateLimited: 0, lastWaitHours: null });
        m.requests += entry.requests;
        m.rateLimited += entry.rateLimited;
        if (entry.lastWaitHours !== null) m.lastWaitHours = entry.lastWaitHours;
        acc.week += entry.requests;
        if (day === today) acc.today += entry.requests;
        if (day === yesterday) acc.yesterday += entry.requests;
      }
    }
  }
  return { accounts, days };
}
