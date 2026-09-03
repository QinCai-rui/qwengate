/*
 * File: accountManager.ts
 * Account management extracted from auth.ts.
 * Handles account CRUD, discovery, persistence, and the account file watcher.
 */
import crypto from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AccountEntry } from '../types/auth.ts';
import { projectPath } from '../utils/paths.ts';
import { config } from './configService.ts';
import { loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';
import { configureAccount } from './qwenModels.ts';

/** In-memory account registry. Mutations must stay synchronous. */
export const accounts: AccountEntry[] = [];

const ACCOUNTS_FILE = projectPath('.qwen', 'accounts.json');
const FALLBACK_ACCOUNTS_FILE = projectPath('.qwen', 'accounts.jsonc');
const QWEN_DIR = projectPath('.qwen');

const OLD_ACCOUNTS_FILE = projectPath('qwen_profile', 'accounts.json');

function getProfileDirForEmail(email: string): string {
  const normalized = email.toLowerCase().trim();
  const safe = normalized.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const suffix = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return projectPath('.qwen', 'browser-profiles', `${safe}-${suffix}`);
}

export function migrateFromOldPaths(): void {
  try {
    if (!existsSync(OLD_ACCOUNTS_FILE)) return;
    if (existsSync(ACCOUNTS_FILE) || existsSync(FALLBACK_ACCOUNTS_FILE)) return;

    logStore.log('info', 'auth', 'Migrating data from qwen_profile/ to .qwen/ ...');

    const newDir = path.dirname(ACCOUNTS_FILE);
    if (!existsSync(newDir)) {
      mkdirSync(newDir, { recursive: true });
    }

    const accountsData = readFileSync(OLD_ACCOUNTS_FILE, 'utf-8');
    writeFileSync(ACCOUNTS_FILE, accountsData, 'utf-8');
    logStore.log('info', 'auth', 'Migrated accounts.json from qwen_profile/ to .qwen/');
    logStore.log('info', 'auth', 'Note: old token files are ignored — tokens are now read from browser profiles.');
    logStore.log('info', 'auth', 'Migration complete. Old files preserved.');
  } catch (err: any) {
    logStore.log('error', 'auth', `Migration error: ${err.message}`);
  }
}

export interface CookieData {
  email: string;
  token: string;
  refreshToken: string | null;
  savedAt: number;
  expiresAt: number;
}
/** Strip // and /* * / JSONC comments before JSON.parse */
function stripJsoncComments(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const current = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
        result += current;
      }
      continue;
    }
    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        i++;
      } else if (current === '\n') {
        result += current;
      }
      continue;
    }
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
    } else if (current === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (current === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else {
      result += current;
    }
  }
  return result;
}

interface PersistedAccountData {
  email: string;
  password: string;
  throttledUntil?: number;
  disabled?: boolean;
  profileCookies?: string;
}
export function parseAccountsFromEnv(): Array<{
  email: string;
  password: string;
  throttledUntil?: number;
  disabled?: boolean;
  profileCookies?: string;
}> {
  const result: Array<{
    email: string;
    password: string;
    throttledUntil?: number;
    disabled?: boolean;
    profileCookies?: string;
  }> = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^ACCOUNT\d+$/i.test(key) || !value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const email = trimmed.substring(0, colonIdx).trim();
    const password = trimmed.substring(colonIdx + 1).trim();
    if (email && password) {
      result.push({ email, password });
    }
  }
  return result;
}
export function discoverSavedAccounts(): Array<{
  email: string;
  password: string;
  throttledUntil?: number;
  disabled?: boolean;
  profileCookies?: string;
}> {
  return parseAccountsFromEnv();
}

/**
 * Decode a JWT token and return its payload, or null if invalid.
 */
export function decodeJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
/* ── AES-256-GCM password encryption ── */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const MASTER_KEY_FILE = projectPath('.qwen', 'master.key');

function getEncryptionKey(): string {
  // The master key is independent from API_KEY so rotating API credentials does
  // not make persisted account credentials undecryptable.
  try {
    if (existsSync(MASTER_KEY_FILE)) {
      return readFileSync(MASTER_KEY_FILE, 'utf-8').trim();
    }
  } catch {
    // Fall through to other strategies
  }

  // Generate a persistent master key on first use.
  try {
    const dir = path.dirname(MASTER_KEY_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const newKey = crypto.randomBytes(32).toString('hex');
    writeFileSync(MASTER_KEY_FILE, newKey, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(MASTER_KEY_FILE, 0o600);
    return newKey;
  } catch {
    // If the filesystem is unwritable, retain compatibility with the old API_KEY
    // keying scheme before falling back to a host-bound key.
    const apiKey = config.get('API_KEY');
    if (apiKey) return apiKey;
    const machineId = `${os.hostname()}-${projectPath('.')}`;
    return crypto.createHash('sha256').update(machineId).digest('hex');
  }
}

let usedLegacyEncryptionKey = false;

function decryptWithKey(encryptedText: string, keyMaterial: string): string | null {
  const parts = encryptedText.split(':');
  const versioned = parts[0] === 'qg1';
  if (versioned && parts.length !== 4) return null;
  if (!versioned && parts.length !== 3) return null;
  const [, ivHex, authTagHex, encrypted] = versioned ? parts : ['', ...parts];
  try {
    const key = deriveKey(keyMaterial);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

function deriveKey(keyMaterial: string): Buffer {
  return crypto.scryptSync(keyMaterial, 'qwen-gate-salt', 32);
}

export function encrypt(plaintext: string): string {
  const key = deriveKey(getEncryptionKey());
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return 'qg1:' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

export function decrypt(encryptedText: string): string {
  usedLegacyEncryptionKey = false;
  const primaryKey = getEncryptionKey();
  const decrypted = decryptWithKey(encryptedText, primaryKey);
  if (decrypted !== null) return decrypted;

  // qg1 and the unversioned three-part format may have been encrypted with the
  // pre-migration API_KEY-derived key. Try it only as a read-time fallback.
  const legacyKey = config.get('API_KEY');
  if (legacyKey && legacyKey !== primaryKey) {
    const legacyDecrypted = decryptWithKey(encryptedText, legacyKey);
    if (legacyDecrypted !== null) {
      usedLegacyEncryptionKey = true;
      return legacyDecrypted;
    }
  }

  logStore.log('error', 'auth', 'Decryption failed — corrupted data or unavailable encryption key');
  return '';
}

// Backward-compatible aliases for existing callers
function encryptPassword(password: string): string {
  return encrypt(password);
}

function decryptPassword(encryptedText: string): string {
  if (encryptedText.startsWith('qg1:')) return decrypt(encryptedText);
  if (encryptedText.split(':').length === 3) {
    const decrypted = decrypt(encryptedText);
    return decrypted || encryptedText;
  }
  return encryptedText;
}

// O(1) email→account lookup index (synced with accounts array mutations)
const emailIndex = new Map<string, AccountEntry>();

export function rebuildEmailIndex(): void {
  emailIndex.clear();
  for (const acct of accounts) {
    emailIndex.set(acct.email.toLowerCase().trim(), acct);
  }
}

export function saveAccountsToFile(
  accounts: ReadonlyArray<
    Pick<AccountEntry, 'email' | 'password'> & Partial<Pick<AccountEntry, 'profileCookies' | 'throttledUntil' | 'disabled'>>
  >,
): void {
  const dir = path.dirname(ACCOUNTS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const data: PersistedAccountData[] = accounts
    .filter((a) => a.password)
    .map((a) => ({
      email: a.email,
      password: encryptPassword(a.password),
      ...(a.profileCookies ? { profileCookies: encrypt(a.profileCookies) } : {}),
      ...((a.throttledUntil ?? 0) > Date.now() ? { throttledUntil: a.throttledUntil } : {}),
      ...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
    }));
  const tmpFile = `${ACCOUNTS_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  chmodSync(tmpFile, 0o600);
  renameSync(tmpFile, ACCOUNTS_FILE);
  chmodSync(ACCOUNTS_FILE, 0o600);
}
export function loadAccountsFromFile(): Array<{
  email: string;
  password: string;
  throttledUntil?: number;
  disabled?: boolean;
  profileCookies?: string;
}> {
  const tryLoad = (
    filePath: string,
  ): Array<{
    email: string;
    password: string;
    throttledUntil?: number;
    disabled?: boolean;
    profileCookies?: string;
  }> | null => {
    try {
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, 'utf-8');
      const data: PersistedAccountData[] = JSON.parse(stripJsoncComments(raw));
      let needsMigration = false;
      const loaded = data
        .filter((d) => d.email && d.password)
        .map((d) => {
          const password = decryptPassword(d.password);
          const passwordUsedLegacyKey = usedLegacyEncryptionKey;
          const profileCookies = d.profileCookies ? decrypt(d.profileCookies) : undefined;
          const profileCookiesUsedLegacyKey = usedLegacyEncryptionKey;
          if (
            !d.password.startsWith('qg1:') ||
            (d.profileCookies && !d.profileCookies.startsWith('qg1:')) ||
            passwordUsedLegacyKey ||
            profileCookiesUsedLegacyKey
          ) {
            needsMigration = true;
          }
          return {
            email: d.email,
            password,
            profileCookies,
            throttledUntil: d.throttledUntil,
            disabled: d.disabled ?? false,
          };
        });
      if (needsMigration) {
        try {
          saveAccountsToFile(loaded);
        } catch (migrationError: any) {
          logStore.log('warn', 'auth', `Failed to migrate account secrets: ${migrationError.message}`);
        }
      }
      return loaded;
    } catch (err: any) {
      logStore.log('error', 'auth', `Failed to load ${filePath}: ${err.message}`);
      return null;
    }
  };

  return tryLoad(ACCOUNTS_FILE) ?? tryLoad(FALLBACK_ACCOUNTS_FILE) ?? [];
}
export async function addAccount(email: string, password: string): Promise<{ loginSucceeded: boolean; loginError?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = accounts.find((a) => a.email.toLowerCase().trim() === normalizedEmail);
  if (existing) {
    throw new Error(`Account with email ${normalizedEmail} already exists`);
  }
  const entry: AccountEntry = {
    email: normalizedEmail,
    password,
    state: null,
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    disabled: false,
  };
  accounts.push(entry);
  rebuildEmailIndex();
  saveAccountsToFile(accounts);

  // Step 1: Create and authorize the browser profile
  const { openBrowserProfile } = await import('./browserProfiles.ts');
  let profileResult = await openBrowserProfile(normalizedEmail, password, { headless: true });
  if (profileResult === 'captcha') {
    logStore.log('info', 'account', `Captcha for ${normalizedEmail} — opening headed browser...`);
    profileResult = await openBrowserProfile(normalizedEmail, password, { headless: false });
  }

  if (profileResult === 'success') {
    // Step 2: Extract token from the now-authenticated profile
    const { loadCookiesFromProfile } = await import('./auth.ts');
    const profileState = await loadCookiesFromProfile(normalizedEmail);
    if (profileState) {
      entry.state = profileState;
      await configureAccount(normalizedEmail).catch((err) =>
        logStore.log('error', 'account', `Failed to configure ${normalizedEmail}: ${err.message}`),
      );
      return { loginSucceeded: true };
    }
  }

  // Fallback: try API login if profile authorization failed
  const newState = await loginFresh(normalizedEmail, password);
  if (newState) {
    entry.state = newState;
    await configureAccount(normalizedEmail).catch((err) =>
      logStore.log('error', 'account', `Failed to configure ${normalizedEmail}: ${err.message}`),
    );
    return { loginSucceeded: true };
  } else {
    const msg = `Login failed: wrong password or CAPTCHA required for ${normalizedEmail}. Check system logs.`;
    logStore.log('warn', 'auth', msg);
    return { loginSucceeded: false, loginError: msg };
  }
}
export async function removeAccount(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const index = accounts.findIndex((a) => a.email.toLowerCase().trim() === normalizedEmail);
  if (index === -1) {
    throw new Error(`Account with email ${normalizedEmail} not found`);
  }
  accounts.splice(index, 1);
  rebuildEmailIndex();
  saveAccountsToFile(accounts);
  const { removeAccountContext } = await import('./playwright.ts');
  removeAccountContext(normalizedEmail);
  const profileDir = getProfileDirForEmail(normalizedEmail);
  if (existsSync(profileDir)) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (err: any) {
      logStore.log('error', 'auth', `Failed to delete Chromium profile for ${normalizedEmail}: ${err.message}`);
    }
  }
}
/**
 * Re-scan accounts and merge changes into the live accounts array.
 */
export async function reloadAccounts(): Promise<void> {
  const discovered = [...discoverSavedAccounts(), ...loadAccountsFromFile()];
  const discoveredEmails = new Set(discovered.map((d) => d.email.toLowerCase().trim()));
  const existingEmails = new Set(accounts.map((a) => a.email.toLowerCase().trim()));
  let added = 0;
  let removed = 0;
  for (const d of discovered) {
    if (!d.password) continue;
    const email = d.email.toLowerCase().trim();
    if (!existingEmails.has(email)) {
      const entry: AccountEntry = {
        email,
        password: d.password,
        state: null,
        lastUsed: 0,
        throttledUntil: d.throttledUntil && d.throttledUntil > Date.now() ? d.throttledUntil : 0,
        refreshInFlight: null,
        loginAttempt: 0,
        inFlight: 0,
        totalRequests: 0,
        profileCookies: d.profileCookies,
        disabled: d.disabled ?? false,
      };
      const { loadCookiesFromProfile } = await import('./auth.ts');
      const profileState = await loadCookiesFromProfile(email);
      if (profileState) {
        entry.state = profileState;
      }
      accounts.push(entry);
      added++;
    }
  }
  for (let i = accounts.length - 1; i >= 0; i--) {
    const acct = accounts[i];
    if (!discoveredEmails.has(acct.email.toLowerCase().trim())) {
      const profileDir = getProfileDirForEmail(acct.email);
      if (existsSync(profileDir)) {
        continue;
      }
      if (acct.inFlight > 0) {
        continue;
      }
      accounts.splice(i, 1);
      removed++;
    }
  }
  if (added > 0 || removed > 0) rebuildEmailIndex();
}
let accountWatcher: any = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Set up fs.watch on .qwen/ directory with 500ms debounce to detect accounts.json changes.
 */
export function setupAccountWatcher(): void {
  if (accountWatcher) return;
  if (!existsSync(QWEN_DIR)) {
    mkdirSync(QWEN_DIR, { recursive: true });
  }
  try {
    accountWatcher = watch(QWEN_DIR, (_eventType: string, filename: string | null) => {
      if (!filename || filename !== 'accounts.json') return;
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        reloadDebounceTimer = null;
        reloadAccounts().catch((err) => {
          logStore.log('error', 'auth', `Hot-reload failed: ${err.message}`);
        });
      }, 500);
    });
    accountWatcher.on('error', (err: any) => {
      logStore.log('error', 'auth', `Account watcher error: ${err.message}`);
      try {
        accountWatcher?.close();
      } catch {
        // non-blocking: watcher may already be closed
      }
      accountWatcher = null;
      if (watcherRetryTimer) clearTimeout(watcherRetryTimer);
      watcherRetryTimer = setTimeout(() => {
        watcherRetryTimer = null;
        setupAccountWatcher();
      }, 10000);
      watcherRetryTimer.unref();
    });
  } catch (err: any) {
    logStore.log('error', 'auth', `Failed to set up account watcher: ${err.message}`);
  }
}
/**
 * Enable hot-reload by starting the account file watcher.
 */
export function enableHotReload(): void {
  setupAccountWatcher();
}
export function resetWatcherState(): void {
  if (watcherRetryTimer) {
    clearTimeout(watcherRetryTimer);
    watcherRetryTimer = null;
  }
}
export function isAvailable(acct: AccountEntry): boolean {
  if (acct.disabled) return false;
  if (!acct.state) return false;
  if (acct.state.expiresAt <= Date.now()) return false;
  if (acct.throttledUntil > Date.now()) return false;
  return true;
}
export async function pickAccount(excludeEmail?: string): Promise<AccountEntry | null> {
  // No lock needed — all operations are synchronous and fast.
  // Worst case for concurrent access: slightly imbalanced inFlight count,
  // which is acceptable for load-balancing purposes.
  try {
    let available = accounts.filter(isAvailable);
    if (excludeEmail) {
      const normalizedExclude = excludeEmail.toLowerCase().trim();
      available = available.filter((a) => a.email.toLowerCase().trim() !== normalizedExclude);
    }
    if (available.length === 0) {
      // All accounts are throttled or unauthenticated — return null instead
      // of falling back to a throttled account (which would guaranteed fail).
      // The caller should return a proper "all accounts exhausted" error.
      if (accounts.length === 0) {
        return null;
      }
      const throttled = accounts.filter((a) => a.throttledUntil > Date.now()).length;
      const noState = accounts.filter((a) => !a.state).length;
      logStore.log('warn', 'auth', `All ${accounts.length} accounts exhausted — ${throttled} throttled, ${noState} unauthenticated`);
      return null;
    }
    const pool = available.filter((a) => a.inFlight === 0);
    const candidates = pool.length > 0 ? pool : available;
    // Single-pass O(N) min-find instead of O(N log N) sort
    let bestIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      const a = candidates[i];
      const b = candidates[bestIdx];
      if (
        a.inFlight < b.inFlight ||
        (a.inFlight === b.inFlight && a.totalRequests < b.totalRequests) ||
        (a.inFlight === b.inFlight && a.totalRequests === b.totalRequests && (a.lastUsed || 0) < (b.lastUsed || 0))
      ) {
        bestIdx = i;
      }
    }
    const picked = candidates[bestIdx];
    logStore.log(
      'debug',
      'auth',
      `[Account] Picked ${picked.email} — inFlight=${picked.inFlight} totalReqs=${picked.totalRequests} lastUsed=${picked.lastUsed ? Date.now() - picked.lastUsed + 'ms ago' : 'never'}${excludeEmail ? ` (excluded: ${excludeEmail})` : ''}`,
    );
    picked.lastUsed = Date.now();
    picked.inFlight++;
    picked.lastInFlightAt = Date.now();
    return picked;
  } catch (err: any) {
    logStore.log('error', 'auth', 'pickAccount error:', err);
    return null;
  }
}
export function incrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) {
    acct.inFlight++;
    acct.lastInFlightAt = Date.now();
  }
}
export function decrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct && acct.inFlight > 0) {
    acct.inFlight--;
    if (acct.inFlight === 0) acct.lastInFlightAt = undefined;
  }
}
export function incrementTotalRequests(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) acct.totalRequests++;
}
export function hasInFlight(email: string): boolean {
  const acct = getAccountByEmail(email);
  return acct ? acct.inFlight > 0 : false;
}
export function getAccountByEmail(email: string): AccountEntry | null {
  return emailIndex.get(email.toLowerCase().trim()) || null;
}
export function setAccountDisabled(email: string, disabled: boolean): void {
  const acct = getAccountByEmail(email);
  if (!acct) throw new Error(`Account not found: ${email}`);
  acct.disabled = disabled;
  saveAccountsToFile(accounts);
}

export function throttleAccount(email: string, durationMs?: number): void {
  const acct = getAccountByEmail(email);
  if (!acct) return;
  const cooldown = durationMs || config.getInt('RATE_LIMIT_COOLDOWN_MS', 120000);
  acct.throttledUntil = Date.now() + cooldown;
  const unlockTime = new Date(acct.throttledUntil).toISOString();
  const hours = Math.ceil(cooldown / 3600000);
  logStore.log('warn', 'auth', `Throttled ${email} — unlocks at ${unlockTime} (${hours}h)`);
  // Persist so restart respects the cooldown
  saveAccountsToFile(accounts);
}
export function isAccountThrottled(email: string): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return true;
  return acct.throttledUntil > Date.now();
}
export function getAccountStats(): Array<{
  email: string;
  authenticated: boolean;
  throttled: boolean;
  disabled: boolean;
  throttledRemainingMs: number;
  throttledUnlockAt: string | null;
  tokenExpiresInMs: number;
  lastUsedAgoMs: number;
  inFlight: number;
  totalRequests: number;
}> {
  const now = Date.now();
  return accounts.map((a) => ({
    email: a.email,
    authenticated: Boolean(a.state?.token && a.state.expiresAt > now),
    throttled: a.throttledUntil > now,
    disabled: a.disabled ?? false,
    throttledRemainingMs: Math.max(0, a.throttledUntil - now),
    throttledUnlockAt: a.throttledUntil > now ? new Date(a.throttledUntil).toISOString() : null,
    tokenExpiresInMs: a.state ? a.state.expiresAt - now : 0,
    lastUsedAgoMs: a.lastUsed ? now - a.lastUsed : -1,
    inFlight: a.inFlight,
    totalRequests: a.totalRequests,
  }));
}
export function getAccountCount(): number {
  return accounts.length;
}
export function getAvailableCount(): number {
  return accounts.filter(isAvailable).length;
}
export function getAllAccountEmails(): string[] {
  return accounts.map((a) => a.email);
}
export function getAccounts(): readonly AccountEntry[] {
  return [...accounts];
}
export async function getToken(): Promise<string | null> {
  const acct = await pickAccount();
  if (acct) {
    decrementInFlight(acct.email);
    return acct.state?.token || null;
  }
  return null;
}
export async function getTokenWithAccount(email?: string): Promise<{ token: string; email: string } | null> {
  let acct: AccountEntry | null;
  let picked = false;
  if (email) {
    acct = getAccountByEmail(email);
    if (acct && !isAvailable(acct) && acct.state) {
      // Account exists but throttled — still return it
    }
  } else {
    acct = await pickAccount();
    picked = true;
  }
  if (!acct?.state?.token || acct.state.expiresAt <= Date.now()) {
    if (picked && acct) decrementInFlight(acct.email);
    return null;
  }
  acct.lastUsed = Date.now();
  if (picked) decrementInFlight(acct.email);
  return { token: acct.state.token, email: acct.email };
}
