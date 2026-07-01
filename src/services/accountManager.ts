/*
 * File: accountManager.ts
 * Account management extracted from auth.ts.
 * Handles account CRUD, discovery, persistence, and the account file watcher.
 */
import crypto from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AccountEntry, AuthState, ProviderAuthState } from '../types/auth.ts';
import { projectPath } from '../utils/paths.ts';
import { config } from './configService.ts';
import { loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';
import { configureAccount } from './qwenModels.ts';

/** In-memory account registry. Mutations must stay synchronous. */
export const accounts: AccountEntry[] = [];

const AUTH_FILE = projectPath('.auth', 'auth.json');
const FALLBACK_AUTH_FILE = projectPath('.auth', 'auth.jsonc');
const AUTH_DIR = projectPath('.auth');

const AUTH_QWEN_FILE = projectPath('.auth', 'auth.qwen.json');
const AUTH_DEEPSEEK_FILE = projectPath('.auth', 'auth.deepseek.json');
const AUTH_GLM_FILE = projectPath('.auth', 'auth.glm.json');
const AUTH_META_FILE = projectPath('.auth', 'auth.meta.json');

const OLD_AUTH_FILE = projectPath('qwen_profile', 'accounts.json');

function getProfileDirForEmail(email: string): string {
  const safe = email
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '_');
  return projectPath('.auth', 'account-profile', safe);
}

export function migrateFromOldPaths(): void {
  try {
    // Migration v1: qwen_profile/ -> .auth/
    if (existsSync(OLD_AUTH_FILE) && !existsSync(AUTH_FILE) && !existsSync(FALLBACK_AUTH_FILE)) {
      logStore.log('info', 'auth', 'Migrating data from qwen_profile/ to .auth/ ...');

      const newDir = path.dirname(AUTH_FILE);
      if (!existsSync(newDir)) {
        mkdirSync(newDir, { recursive: true });
      }

      const accountsData = readFileSync(OLD_AUTH_FILE, 'utf-8');
      writeFileSync(AUTH_FILE, accountsData, 'utf-8');
      logStore.log('info', 'auth', 'Migrated auth.json from qwen_profile/ to .auth/');
      logStore.log('info', 'auth', 'Note: old token files are ignored — tokens are now read from browser profiles.');
      logStore.log('info', 'auth', 'Migration complete. Old files preserved.');
    }

    // Migration v2: .qwen/ -> .auth/ (rename entire directory)
    const oldQwenDir = projectPath('.qwen');
    const newAuthDir = projectPath('.auth');
    if (existsSync(oldQwenDir) && !existsSync(newAuthDir)) {
      renameSync(oldQwenDir, newAuthDir);
      logStore.log('info', 'auth', 'Migrated .qwen/ to .auth/');
    }

    // Migration v3: .qwen/accounts.json -> .auth/auth.json (partial migration)
    const oldAccountsFile = projectPath('.qwen', 'accounts.json');
    const newAuthFile = projectPath('.auth', 'auth.json');
    if (existsSync(oldAccountsFile) && !existsSync(newAuthFile)) {
      const dir = path.dirname(newAuthFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      copyFileSync(oldAccountsFile, newAuthFile);
      logStore.log('info', 'auth', 'Migrated accounts.json to auth.json');
    }
  } catch (err: any) {
    logStore.log('error', 'auth', `Migration error: ${err.message}`);
  }
}

/** Strip // and /* * / JSONC comments before JSON.parse */
function stripJsoncComments(text: string): string {
  // Strip // comments only outside of strings (not inside quoted values like URLs)
  // ponytail: simple state machine — tracks whether we're inside a string
  let result = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (!inString && ch === '/' && text[i + 1] === '/') {
      // Skip to end of line
      const eol = text.indexOf('\n', i);
      if (eol === -1) break;
      i = eol;
      result += '\n';
      continue;
    }
    if (!inString && ch === '/' && text[i + 1] === '*') {
      // Skip to closing */
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    result += ch;
  }
  return result;
}

interface PersistedAccountData {
  email: string;
  password: string;
  providers?: string[];
  throttledUntil?: number;
  disabled?: boolean;
  disabledProviders?: string[];
  providerStates?: { [provider: string]: { token?: string; expiresAt?: number; cookies?: string; captchaVerifyParam?: string } };
}
function parseAccountsFromEnv(): Array<{ email: string; password: string }> {
  const result: Array<{ email: string; password: string }> = [];
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
export function discoverSavedAccounts(): Array<{ email: string; password: string }> {
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
const MASTER_KEY_FILE = projectPath('.auth', 'master.key');

function getEncryptionKey(): string {
  // 1. If a master key file exists, use it (survives API_KEY changes)
  try {
    if (existsSync(MASTER_KEY_FILE)) {
      return readFileSync(MASTER_KEY_FILE, 'utf-8').trim();
    }
  } catch {
    // Fall through to other strategies
  }

  // 2. Use API_KEY as encryption key (backward compatibility)
  const apiKey = config.get('API_KEY');
  if (apiKey) return apiKey;

  // 3. Generate a persistent master key on first use
  try {
    const dir = path.dirname(MASTER_KEY_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const newKey = crypto.randomBytes(32).toString('hex');
    writeFileSync(MASTER_KEY_FILE, newKey, 'utf-8');
    return newKey;
  } catch {
    // 4. Fallback: hostname-based key (only when filesystem is unwritable)
    const machineId = `${os.hostname()}-${projectPath('.')}`;
    return crypto.createHash('sha256').update(machineId).digest('hex');
  }
}

function deriveKey(keyMaterial: string): Buffer {
  return crypto.scryptSync(keyMaterial, 'opengate-salt', 32);
}

function encrypt(plaintext: string): string {
  const key = deriveKey(getEncryptionKey());
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) return encryptedText;
  const [ivHex, authTagHex, encrypted] = parts;
  try {
    const key = deriveKey(getEncryptionKey());
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    logStore.log('error', 'auth', 'Decryption failed — wrong API_KEY or corrupted data');
    return '';
  }
}

// Backward-compatible aliases for existing callers
function encryptPassword(password: string): string {
  return encrypt(password);
}

function decryptPassword(encryptedText: string): string {
  return decrypt(encryptedText);
}

// O(1) email→account lookup index (synced with accounts array mutations)
const emailIndex = new Map<string, AccountEntry>();

export function rebuildEmailIndex(): void {
  emailIndex.clear();
  for (const acct of accounts) {
    emailIndex.set(acct.email.toLowerCase().trim(), acct);
  }
}

/* ── Per-provider file persistence ── */

interface PersistedMetaData {
  throttled: Record<string, number>;
  disabled: Record<string, boolean>;
  disabledProviders: Record<string, string[]>;
}

function loadMetaFile(): PersistedMetaData {
  try {
    if (!existsSync(AUTH_META_FILE)) return { throttled: {}, disabled: {}, disabledProviders: {} };
    const raw = readFileSync(AUTH_META_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { throttled: {}, disabled: {}, disabledProviders: {} };
  }
}

/** One-time migration: split old auth.json into per-provider files + meta. */
function migrateAuthFiles(): void {
  if (!existsSync(AUTH_FILE)) return;
  if (existsSync(AUTH_QWEN_FILE)) return; // already migrated

  logStore.log('info', 'auth', 'Migrating auth.json to per-provider files...');

  try {
    const raw = readFileSync(AUTH_FILE, 'utf-8');
    const data = JSON.parse(stripJsoncComments(raw));
    if (!Array.isArray(data)) return;

    const qwen: Array<{ email: string; password: string }> = [];
    const deepseek: Array<{ email: string; password: string }> = [];
    const glm: Array<{ email: string; password: string }> = [];
    const throttled: Record<string, number> = {};
    const disabled: Record<string, boolean> = {};
    const disabledProviders: Record<string, string[]> = {};

    for (const acct of data) {
      if (!acct.email || !acct.password) continue;
      const providers = acct.providers || ['qwen'];
      const password = decryptPassword(acct.password);
      const entry = { email: acct.email, password };

      if (providers.includes('qwen')) qwen.push(entry);
      if (providers.includes('deepseek')) deepseek.push(entry);
      if (providers.includes('glm')) glm.push(entry);

      if (acct.throttledUntil > Date.now()) throttled[acct.email.toLowerCase().trim()] = acct.throttledUntil;
      if (acct.disabled) disabled[acct.email.toLowerCase().trim()] = true;
      if (acct.disabledProviders?.length) disabledProviders[acct.email.toLowerCase().trim()] = acct.disabledProviders;
    }

    const authDir = path.dirname(AUTH_FILE);
    if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });

    if (qwen.length > 0) writeFileSync(AUTH_QWEN_FILE, JSON.stringify(qwen, null, 2), 'utf-8');
    if (deepseek.length > 0) writeFileSync(AUTH_DEEPSEEK_FILE, JSON.stringify(deepseek, null, 2), 'utf-8');
    if (glm.length > 0) writeFileSync(AUTH_GLM_FILE, JSON.stringify(glm, null, 2), 'utf-8');
    writeFileSync(AUTH_META_FILE, JSON.stringify({ throttled, disabled, disabledProviders }, null, 2), 'utf-8');

    // Backup old auth.json
    renameSync(AUTH_FILE, AUTH_FILE + '.bak');
    logStore.log('info', 'auth', `Migrated ${data.length} accounts to per-provider auth files. Old auth.json backed up.`);
  } catch (err: any) {
    logStore.log('error', 'auth', `Migration failed: ${err.message} — falling back to auth.json`);
  }
}

/**
 * Save ONLY meta data (throttledUntil, disabled, disabledProviders) to .auth/auth.meta.json.
 * Per-provider auth files are NOT written by the app — only user-edited.
 * Tokens, cookies, captchaVerifyParam are NOT persisted to files — loaded from browser profiles.
 */
export function saveAccountsToFile(accounts: readonly AccountEntry[]): void {
  const dir = path.dirname(AUTH_META_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const throttled: Record<string, number> = {};
  const disabled: Record<string, boolean> = {};
  const disabledProviders: Record<string, string[]> = {};

  for (const acct of accounts) {
    if (acct.throttledUntil > Date.now()) {
      throttled[acct.email] = acct.throttledUntil;
    }
    if (acct.disabled) {
      disabled[acct.email] = true;
    }
    if (acct.disabledProviders && acct.disabledProviders.length > 0) {
      disabledProviders[acct.email] = acct.disabledProviders;
    }
  }

  writeFileSync(AUTH_META_FILE, JSON.stringify({ throttled, disabled, disabledProviders }, null, 2), 'utf-8');
}
export function loadAccountsFromFile(): PersistedAccountData[] {
  // Migration: if auth.json exists but no per-provider files, migrate
  migrateAuthFiles();

  // Try per-provider files
  const providerConfigs: Array<{ file: string; name: string }> = [
    { file: AUTH_QWEN_FILE, name: 'qwen' },
    { file: AUTH_DEEPSEEK_FILE, name: 'deepseek' },
    { file: AUTH_GLM_FILE, name: 'glm' },
  ];

  const loaded: Array<{ entries: Array<{ email: string; password: string }>; name: string }> = [];
  let hasAnyProviderFile = false;

  for (const { file, name } of providerConfigs) {
    try {
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf-8');
      const entries = JSON.parse(stripJsoncComments(raw));
      if (!Array.isArray(entries) || entries.length === 0) continue;
      hasAnyProviderFile = true;
      loaded.push({ entries, name });
    } catch {
      // skip unreadable files
    }
  }

  if (hasAnyProviderFile) {
    // Merge accounts by email — providers = which files the account appeared in
    const accountMap = new Map<string, PersistedAccountData>();

    for (const { entries, name } of loaded) {
      for (const entry of entries) {
        const email = entry.email?.toLowerCase().trim();
        if (!email || !entry.password) continue;
        const existing = accountMap.get(email);
        if (existing) {
          if (!existing.providers?.includes(name)) {
            existing.providers = [...(existing.providers || []), name];
          }
        } else {
          accountMap.set(email, {
            email: entry.email,
            password: decryptPassword(entry.password),
            providers: [name],
          });
        }
      }
    }

    // Load meta data (throttledUntil, disabled, disabledProviders)
    const meta = loadMetaFile();
    for (const [, data] of accountMap) {
      const key = data.email.toLowerCase().trim();
      if (meta.throttled[key]) data.throttledUntil = meta.throttled[key];
      if (meta.disabled[key]) data.disabled = true;
      if (meta.disabledProviders[key]) data.disabledProviders = meta.disabledProviders[key];
    }

    return Array.from(accountMap.values());
  }

  // Fall back to old auth.json (backward compatibility)
  const tryLoadOld = (filePath: string): PersistedAccountData[] | null => {
    try {
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, 'utf-8');
      const data: PersistedAccountData[] = JSON.parse(stripJsoncComments(raw));
      return data
        .filter((d) => d.email && d.password)
        .map((d) => ({
          email: d.email,
          password: decryptPassword(d.password),
          providers: d.providers,
          throttledUntil: d.throttledUntil,
          disabledProviders: d.disabledProviders,
          providerStates: d.providerStates,
        }));
    } catch (err: any) {
      logStore.log('error', 'auth', `Failed to load ${filePath}: ${err.message}`);
      return null;
    }
  };

  const fallback = tryLoadOld(AUTH_FILE) ?? tryLoadOld(FALLBACK_AUTH_FILE) ?? [];

  // Phase 2 (backward compat): Restore provider states from old persisted data
  for (const p of fallback) {
    if (p.providerStates) {
      const acct = accounts.find((a) => a.email.toLowerCase().trim() === p.email.toLowerCase().trim());
      if (acct) {
        for (const [provider, ps] of Object.entries(p.providerStates)) {
          if (ps) {
            if (!acct.providerStates[provider]) {
              acct.providerStates[provider] = { token: null, expiresAt: null, refreshToken: null, lastLoginAttempt: null };
            }
            const state = acct.providerStates[provider]!;
            if (ps.cookies) state.cookies = ps.cookies;
            if (ps.captchaVerifyParam) state.captchaVerifyParam = ps.captchaVerifyParam;
          }
        }
      }
    }
  }

  return fallback;
}
/** Append email+password to a per-provider auth file if not already present */
function appendToAuthFile(file: string, email: string, password: string): void {
  let entries: Array<{ email: string; password: string }> = [];
  try {
    if (existsSync(file)) entries = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    /* ignore corrupt file */
  }
  if (entries.some((e) => e.email.toLowerCase().trim() === email.toLowerCase().trim())) return;
  entries.push({ email, password });
  writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8');
}

export async function addAccount(
  email: string,
  password: string,
  providers?: string[],
): Promise<{ loginSucceeded: boolean; loginError?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const newProviders = (providers || ['qwen']).map((p) => p.toLowerCase().trim());
  const existing = accounts.find((a) => a.email.toLowerCase().trim() === normalizedEmail);
  if (existing) {
    // Email exists — check if any requested providers aren't already configured
    const alreadyHas = (existing.providers || []).map((p) => p.toLowerCase().trim());
    const missing = newProviders.filter((p) => !alreadyHas.includes(p));
    if (missing.length === 0) {
      throw new Error(`Account with email ${normalizedEmail} already exists with providers: ${alreadyHas.join(', ')}`);
    }
    // Merge new providers into existing account
    existing.providers = [...new Set([...(existing.providers || []), ...missing])];
    rebuildEmailIndex();
    saveAccountsToFile(accounts);
    // Sync per-provider auth files
    const authFileMap: Record<string, string> = { qwen: AUTH_QWEN_FILE, deepseek: AUTH_DEEPSEEK_FILE, glm: AUTH_GLM_FILE };
    for (const p of missing) {
      if (authFileMap[p]) appendToAuthFile(authFileMap[p], normalizedEmail, password);
    }
    return { loginSucceeded: true };
  }
  const entry: AccountEntry = {
    email: normalizedEmail,
    password,
    providerStates: {},
    providers: providers || ['qwen'],
    disabledProviders: [],
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
  // Sync per-provider auth files
  const authFileMap: Record<string, string> = { qwen: AUTH_QWEN_FILE, deepseek: AUTH_DEEPSEEK_FILE, glm: AUTH_GLM_FILE };
  for (const p of entry.providers || providers || ['qwen']) {
    if (authFileMap[p]) appendToAuthFile(authFileMap[p], normalizedEmail, password);
  }

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
      entry.providerStates.qwen = { ...profileState, lastLoginAttempt: null };
      await configureAccount(normalizedEmail).catch((err) =>
        logStore.log('error', 'account', `Failed to configure ${normalizedEmail}: ${err.message}`),
      );
      return { loginSucceeded: true };
    }
  }

  // Fallback: try API login if profile authorization failed
  const newState = await loginFresh(normalizedEmail, password);
  if (newState) {
    entry.providerStates.qwen = { ...newState, lastLoginAttempt: null };
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
  // Remove from all per-provider auth files
  const authFiles = [AUTH_QWEN_FILE, AUTH_DEEPSEEK_FILE, AUTH_GLM_FILE];
  for (const file of authFiles) {
    try {
      if (!existsSync(file)) continue;
      let entries = JSON.parse(readFileSync(file, 'utf-8'));
      const filtered = entries.filter((e: any) => e.email.toLowerCase().trim() !== normalizedEmail);
      if (filtered.length !== entries.length) {
        writeFileSync(file, JSON.stringify(filtered, null, 2), 'utf-8');
      }
    } catch {
      /* ignore */
    }
  }
}
export async function removeProviderFromAccount(email: string, provider: string): Promise<{ accountDeleted: boolean }> {
  const normalizedEmail = email.toLowerCase().trim();
  const acct = getAccountByEmail(normalizedEmail);
  if (!acct) {
    throw new Error(`Account not found: ${normalizedEmail}`);
  }
  delete acct.providerStates[provider];
  if (acct.providers) {
    acct.providers = acct.providers.filter((p) => p !== provider);
  }
  if (acct.disabledProviders) {
    acct.disabledProviders = acct.disabledProviders.filter((p) => p !== provider);
  }
  saveAccountsToFile(accounts);

  // Remove from the specific provider's auth file
  const authFileMap: Record<string, string> = { qwen: AUTH_QWEN_FILE, deepseek: AUTH_DEEPSEEK_FILE, glm: AUTH_GLM_FILE };
  const providerAuthFile = authFileMap[provider];
  if (providerAuthFile) {
    try {
      if (existsSync(providerAuthFile)) {
        let entries = JSON.parse(readFileSync(providerAuthFile, 'utf-8'));
        const filtered = entries.filter((e: any) => e.email.toLowerCase().trim() !== normalizedEmail);
        if (filtered.length !== entries.length) {
          writeFileSync(providerAuthFile, JSON.stringify(filtered, null, 2), 'utf-8');
        }
      }
    } catch {
      /* ignore */
    }
  }

  const hasOnlyDefaultProviders =
    !acct.providers || acct.providers.length === 0 || (acct.providers.length === 1 && acct.providers[0] === 'qwen');
  const isEmpty = Object.keys(acct.providerStates).length === 0 && hasOnlyDefaultProviders;
  if (isEmpty) {
    await removeAccount(normalizedEmail);
    return { accountDeleted: true };
  }
  return { accountDeleted: false };
}

/**
 * Re-scan accounts and merge changes into the live accounts array.
 */
export async function reloadAccounts(): Promise<void> {
  if (accountWatcher && !watcherReady) {
    return;
  }
  const discovered = discoverSavedAccounts();
  const discoveredEmails = new Set(discovered.map((d) => d.email.toLowerCase().trim()));
  const existingEmails = new Set(accounts.map((a) => a.email.toLowerCase().trim()));
  let added = 0;
  let removed = 0;
  for (const d of discovered) {
    const email = d.email.toLowerCase().trim();
    if (!existingEmails.has(email)) {
      const entry: AccountEntry = {
        email,
        password: d.password,
        providerStates: {},
        providers: ['qwen'],
        disabledProviders: [],
        lastUsed: 0,
        throttledUntil: 0,
        refreshInFlight: null,
        loginAttempt: 0,
        inFlight: 0,
        totalRequests: 0,
        disabled: false,
      };
      const { loadCookiesFromProfile } = await import('./auth.ts');
      const profileState = await loadCookiesFromProfile(email);
      if (profileState) {
        entry.providerStates.qwen = { ...profileState, lastLoginAttempt: null };
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
let watcherReady = false;
let watcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Set up fs.watch on .auth/ directory with 500ms debounce to detect auth.json changes.
 */
export function setupAccountWatcher(): void {
  if (accountWatcher) return;
  if (!existsSync(AUTH_DIR)) {
    mkdirSync(AUTH_DIR, { recursive: true });
  }
  try {
    accountWatcher = watch(AUTH_DIR, (_eventType: string, filename: string | null) => {
      // Watch per-provider files and legacy auth.json for user edits
      if (!filename) return;
      const watchedFiles = ['auth.qwen.json', 'auth.deepseek.json', 'auth.glm.json', 'auth.json'];
      if (!watchedFiles.includes(filename)) return;
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
      watcherReady = false;
      if (watcherRetryTimer) clearTimeout(watcherRetryTimer);
      watcherRetryTimer = setTimeout(() => {
        watcherRetryTimer = null;
        setupAccountWatcher();
      }, 10000);
      watcherRetryTimer.unref();
    });
    setTimeout(() => {
      watcherReady = true;
    }, 2000);
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
  watcherReady = false;
  if (watcherRetryTimer) {
    clearTimeout(watcherRetryTimer);
    watcherRetryTimer = null;
  }
}
export function isAvailable(acct: AccountEntry, provider?: string): boolean {
  if (acct.disabled) return false;
  if (provider && acct.disabledProviders?.includes(provider)) return false;
  if (acct.throttledUntil > Date.now()) return false;
  // Check the specific provider's token if one is specified
  const targetProvider = provider || 'qwen';
  if (!acct.providerStates[targetProvider]?.token) return false;
  return true;
}
export async function pickAccount(excludeEmail?: string): Promise<AccountEntry | null> {
  // No lock needed — all operations are synchronous and fast.
  // Worst case for concurrent access: slightly imbalanced inFlight count,
  // which is acceptable for load-balancing purposes.
  try {
    let available = accounts.filter((a) => isAvailable(a));
    if (excludeEmail) {
      available = available.filter((a) => a.email !== excludeEmail);
    }
    if (available.length === 0) {
      // All accounts are throttled or unauthenticated — return null instead
      // of falling back to a throttled account (which would guaranteed fail).
      // The caller should return a proper "all accounts exhausted" error.
      if (accounts.length === 0) {
        return null;
      }
      const throttled = accounts.filter((a) => a.throttledUntil > Date.now()).length;
      const noState = accounts.filter((a) => !a.providerStates.qwen?.token).length;
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
    // Safety valve: reset if counter drifts unreasonably high
    if (picked.inFlight > 20) picked.inFlight = 0;
    return picked;
  } catch (err: any) {
    logStore.log('error', 'auth', 'pickAccount error:', err);
    return null;
  }
}
/**
 * Pick the best available account for a specific provider (e.g. 'deepseek', 'glm').
 * Falls back to any non-throttled, non-disabled account with a valid token for that provider.
 */
export async function pickAccountForProvider(provider: string, excludeEmail?: string): Promise<AccountEntry | null> {
  try {
    let available = accounts.filter((a) => isAvailable(a, provider));
    if (excludeEmail) {
      available = available.filter((a) => a.email !== excludeEmail);
    }
    if (available.length === 0) {
      const throttled = accounts.filter((a) => a.throttledUntil > Date.now()).length;
      const noState = accounts.filter((a) => !a.providerStates[provider]?.token).length;
      logStore.log(
        'warn',
        'auth',
        `All accounts exhausted for provider ${provider} — ${throttled} throttled, ${noState} no ${provider} token`,
      );
      return null;
    }
    const pool = available.filter((a) => a.inFlight === 0);
    const candidates = pool.length > 0 ? pool : available;
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
      `[Account] Picked ${picked.email} for ${provider} — inFlight=${picked.inFlight} totalReqs=${picked.totalRequests} lastUsed=${picked.lastUsed ? Date.now() - picked.lastUsed + 'ms ago' : 'never'}${excludeEmail ? ` (excluded: ${excludeEmail})` : ''}`,
    );
    picked.lastUsed = Date.now();
    picked.inFlight++;
    if (picked.inFlight > 20) picked.inFlight = 0;
    return picked;
  } catch (err: any) {
    logStore.log('error', 'auth', `pickAccountForProvider error:`, err);
    return null;
  }
}

export function incrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) acct.inFlight++;
}
export function decrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct && acct.inFlight > 0) acct.inFlight--;
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
export function setAccountProviders(email: string, providers: string[]): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return false;
  acct.providers = providers.length > 0 ? [...new Set(providers)] : ['qwen'];
  saveAccountsToFile(accounts);
  return true;
}
export function setProviderDisabled(email: string, provider: string, disabled: boolean): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return false;
  if (!acct.disabledProviders) acct.disabledProviders = [];
  if (disabled) {
    if (!acct.disabledProviders.includes(provider)) acct.disabledProviders.push(provider);
  } else {
    acct.disabledProviders = acct.disabledProviders.filter((p) => p !== provider);
  }
  saveAccountsToFile(accounts);
  return true;
}
export function setProviderStateLastError(email: string, provider: string, errorMsg: string | null): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return false;
  if (!acct.providerStates[provider]) {
    acct.providerStates[provider] = {
      token: null,
      expiresAt: null,
      refreshToken: null,
      lastLoginAttempt: null,
    };
  }
  if (errorMsg) {
    acct.providerStates[provider]!.lastError = errorMsg;
  } else {
    delete acct.providerStates[provider]!.lastError;
  }
  saveAccountsToFile(accounts);
  return true;
}

export function setProviderState(email: string, provider: string, state: ProviderAuthState | null): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return false;
  if (state) {
    acct.providerStates[provider] = state;
  } else {
    delete acct.providerStates[provider];
  }
  saveAccountsToFile(accounts);
  return true;
}

export function getProviderState(email: string, provider: string): ProviderAuthState | null {
  const acct = getAccountByEmail(email);
  if (!acct) return null;
  return acct.providerStates[provider] ?? null;
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
export function getAuthStatus(state: ProviderAuthState | undefined): string {
  if (state?.lastError && /captcha|bot|waf/i.test(state.lastError)) return 'captcha';
  if (!state?.token) return 'disconnected';
  if (state.startupStatus === 'connecting') return 'connecting';
  if (state.startupStatus === 'initializing' || state.startupStatus === 'pending') return 'pending';
  if (state.expiresAt != null && state.expiresAt < Date.now()) return 'expired';
  return 'live';
}

export function getAccountStats(): Array<{
  email: string;
  authenticated: boolean;
  throttled: boolean;
  disabled: boolean;
  disabledProviders: string[];
  throttledRemainingMs: number;
  throttledUnlockAt: string | null;
  tokenExpiresInMs: number;
  lastUsedAgoMs: number;
  inFlight: number;
  totalRequests: number;
  providers: {
    qwen: boolean;
    deepseek: boolean;
    glm: boolean;
  };
  configuredProviders: string[];
  providerAuth: {
    qwen: { status: string; tokenExpiresInMs: number; lastLoginAttempt: number | null; lastError?: string } | null;
    deepseek: { status: string; tokenExpiresInMs: number; lastLoginAttempt: number | null; lastError?: string } | null;
    glm: { status: string; tokenExpiresInMs: number; lastLoginAttempt: number | null; lastError?: string } | null;
  };
}> {
  const now = Date.now();
  return accounts.map((a) => ({
    email: a.email,
    authenticated: a.providerStates.qwen?.token != null,
    throttled: a.throttledUntil > now,
    disabled: a.disabled ?? false,
    disabledProviders: a.disabledProviders || [],
    throttledRemainingMs: Math.max(0, a.throttledUntil - now),
    throttledUnlockAt: a.throttledUntil > now ? new Date(a.throttledUntil).toISOString() : null,
    tokenExpiresInMs: a.providerStates.qwen?.expiresAt ? Math.max(0, a.providerStates.qwen.expiresAt - now) : 0,
    lastUsedAgoMs: a.lastUsed ? now - a.lastUsed : -1,
    inFlight: a.inFlight,
    totalRequests: a.totalRequests,
    providers: {
      qwen: a.providerStates.qwen?.token != null,
      deepseek: a.providerStates.deepseek?.token != null,
      glm: a.providerStates.glm?.token != null,
    },
    configuredProviders: a.providers || ['qwen'],
    providerAuth: {
      qwen: a.providerStates.qwen
        ? {
            status: getAuthStatus(a.providerStates.qwen),
            tokenExpiresInMs: a.providerStates.qwen.expiresAt ? Math.max(0, a.providerStates.qwen.expiresAt - now) : 0,
            lastLoginAttempt: a.providerStates.qwen.lastLoginAttempt,
            lastError: a.providerStates.qwen.lastError,
          }
        : null,
      deepseek: a.providerStates.deepseek
        ? {
            status: getAuthStatus(a.providerStates.deepseek),
            tokenExpiresInMs: a.providerStates.deepseek.expiresAt ? Math.max(0, a.providerStates.deepseek.expiresAt - now) : 0,
            lastLoginAttempt: a.providerStates.deepseek.lastLoginAttempt,
            lastError: a.providerStates.deepseek.lastError,
          }
        : null,
      glm: a.providerStates.glm
        ? {
            status: getAuthStatus(a.providerStates.glm),
            tokenExpiresInMs: a.providerStates.glm.expiresAt ? Math.max(0, a.providerStates.glm.expiresAt - now) : 0,
            lastLoginAttempt: a.providerStates.glm.lastLoginAttempt,
            lastError: a.providerStates.glm.lastError,
          }
        : null,
    },
  }));
}
export function getAccountCount(): number {
  return accounts.length;
}
export function getAvailableCount(): number {
  return accounts.filter((a) => isAvailable(a)).length;
}
export function getAllAccountEmails(): string[] {
  return accounts.map((a) => a.email);
}
export function getAccounts(): readonly AccountEntry[] {
  return [...accounts];
}
/**
 * Get a stored auth token for a specific provider from any available account.
 * Used by provider handlers that want per-account auth instead of env var API keys.
 * Returns the token string, or null if no account has a valid token for this provider.
 */
export function getProviderToken(provider: string): string | null {
  const available = accounts.filter(
    (a) => !a.disabled && !(a.disabledProviders || []).includes(provider) && a.providerStates[provider]?.token != null,
  );
  if (available.length === 0) return null;
  const acct = available[Math.floor(Math.random() * available.length)];
  return acct.providerStates[provider]!.token!;
}

export async function getToken(): Promise<string | null> {
  const acct = await pickAccount();
  if (acct) {
    decrementInFlight(acct.email);
    return acct.providerStates.qwen?.token || null;
  }
  return null;
}
export async function getTokenWithAccount(email?: string): Promise<{ token: string; email: string } | null> {
  let acct: AccountEntry | null;
  let picked = false;
  if (email) {
    acct = getAccountByEmail(email);
    if (acct && !isAvailable(acct) && acct.providerStates.qwen?.token) {
      // Account exists but throttled — still return it
    }
  } else {
    acct = await pickAccount();
    picked = true;
  }
  if (!acct?.providerStates?.qwen?.token) {
    if (picked && acct) decrementInFlight(acct.email);
    return null;
  }
  acct.lastUsed = Date.now();
  if (picked) decrementInFlight(acct.email);
  return { token: acct.providerStates.qwen.token, email: acct.email };
}
