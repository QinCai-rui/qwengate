/*
 * File: autoBrowser.ts
 * Auto-launches a headless Chrome/Chromium browser with CDP on port 9222.
 * If port 9222 is already in use, verifies CDP is reachable and returns success.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import * as net from 'node:net';
import { resolve } from 'node:path';
import { projectPath } from '../utils/paths.ts';
import { logStore } from './logStore.ts';

const CDP_PORT = 26404;
const CDP_HOST = '127.0.0.1';
const CDP_URL = `http://${CDP_HOST}:${CDP_PORT}`;
const CDP_VERSION_URL = `${CDP_URL}/json/version`;
const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 10_000;

const CATEGORY = 'browser';

// Profile directory for the headless instance (avoids user-data conflicts)
const PROFILE_DIR = projectPath('.qwen', 'cdp-profile');

let chromeProcess: ReturnType<typeof Bun.spawn> | null = null;
let sigHandlersRegistered = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a TCP port is in use. */
function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createConnection({ port, host }, () => {
      tester.destroy();
      resolve(true);
    });
    tester.on('error', () => resolve(false));
    tester.setTimeout(1000, () => {
      tester.destroy();
      resolve(false);
    });
  });
}

/** Fetch CDP /json/version endpoint. */
async function fetchCdpVersion(): Promise<boolean> {
  try {
    const res = await fetch(CDP_VERSION_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll until CDP is reachable or timeout. */
async function waitForCdp(): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (await fetchCdpVersion()) return true;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

const CHROME_BINARIES = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];

const EXTRA_CHROME_PATHS = [
  resolve('/home/youssefvdel/.local/bin/google-chrome'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

function findChromeBinary(): string | null {
  // 1. Check PATH-based binaries
  for (const bin of CHROME_BINARIES) {
    try {
      const result = execFileSync('which', [bin], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const path = result.trim();
      if (path && existsSync(path)) {
        logStore.log('info', CATEGORY, `Found Chrome binary at ${path}`);
        return path;
      }
    } catch {
      // not found, continue
    }
  }

  // 2. Check known absolute paths
  for (const p of EXTRA_CHROME_PATHS) {
    if (existsSync(p)) {
      logStore.log('info', CATEGORY, `Found Chrome binary at ${p}`);
      return p;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

// Realistic User-Agent strings for rotation (avoids baxia fingerprinting one static UA)
const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function launchChrome(binary: string): void {
  mkdirSync(PROFILE_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-extensions',
    `--user-data-dir=${PROFILE_DIR}`,
    // Anti-detection: override User-Agent to remove "Headless" marker
    `--user-agent=${USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]}`,
    // Minimal URL to open so Chrome actually starts
    'about:blank',
  ];

  logStore.log('info', CATEGORY, `Launching Chrome: ${binary} ${args.join(' ')}`);

  chromeProcess = Bun.spawn([binary, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TZ: 'UTC' },
  });

  logStore.log('info', CATEGORY, `Chrome launched (pid ${chromeProcess.pid}), waiting for CDP...`);

  // Log stdout/stderr for diagnostics
  const pipeStream = chromeProcess.stdout;
  if (pipeStream && typeof pipeStream !== 'number' && 'getReader' in pipeStream) {
    const reader = pipeStream.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          if (text) logStore.log('debug', CATEGORY, `Chrome stdout: ${text}`);
        }
      } catch {
        // stream closed
      }
    })();
  }
  const errStream = chromeProcess.stderr;
  if (errStream && typeof errStream !== 'number' && 'getReader' in errStream) {
    const reader = errStream.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          if (text) logStore.log('debug', CATEGORY, `Chrome stderr: ${text}`);
        }
      } catch {
        // stream closed
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  if (chromeProcess) {
    logStore.log('info', CATEGORY, `Stopping Chrome (pid ${chromeProcess.pid})...`);
    try {
      chromeProcess.kill('SIGTERM');
    } catch {
      // already dead
    }
    chromeProcess = null;
  }
}

function registerCleanup() {
  if (sigHandlersRegistered) return;
  sigHandlersRegistered = true;
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('exit', cleanup);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BrowserStartResult {
  success: boolean;
  cdpEndpoint: string;
  alreadyRunning: boolean;
  error?: string;
}

/**
 * Start or verify the headless Chrome CDP browser.
 *
 * - If port 9222 is already in use, verifies CDP and returns success.
 * - Otherwise launches Chrome headless and waits for CDP to be ready.
 */
export async function startBrowser(): Promise<BrowserStartResult> {
  const alreadyRunning = await isPortInUse(CDP_PORT, CDP_HOST);

  if (alreadyRunning) {
    logStore.log('info', CATEGORY, `Port ${CDP_PORT} already in use, verifying CDP...`);
    if (await fetchCdpVersion()) {
      logStore.log('info', CATEGORY, 'Existing CDP instance verified');
      return { success: true, cdpEndpoint: CDP_URL, alreadyRunning: true };
    }
    logStore.log('warn', CATEGORY, `Port ${CDP_PORT} in use but CDP not reachable, attempting launch anyway`);
  }

  const binary = findChromeBinary();
  if (!binary) {
    const msg = 'Chrome/Chromium not found. Install google-chrome or chromium-browser.';
    logStore.log('error', CATEGORY, msg);
    return { success: false, cdpEndpoint: CDP_URL, alreadyRunning: false, error: msg };
  }

  launchChrome(binary);
  registerCleanup();

  const ready = await waitForCdp();
  if (!ready) {
    const msg = `Chrome launched but CDP not ready after ${MAX_WAIT_MS / 1000}s`;
    logStore.log('error', CATEGORY, msg);
    cleanup();
    return { success: false, cdpEndpoint: CDP_URL, alreadyRunning: false, error: msg };
  }

  logStore.log('info', CATEGORY, `CDP ready at ${CDP_URL}`);
  return { success: true, cdpEndpoint: CDP_URL, alreadyRunning: false };
}

/** Kill the spawned Chrome process (called on server shutdown). */
export function stopBrowser(): void {
  cleanup();
}
