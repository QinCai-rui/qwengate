import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');

const DEFAULTS = {
  PORT: '26405',
  HOST: 'localhost',
  API_KEY: '',
  BROWSER: 'chromium',
  DASHBOARD: 'true',
  ASTRO_PORT: '4321',
  ECHO_DETECTOR: 'true',
  ECHO_JACCARD_THRESHOLD: '0.9',
  TOOL_CALLING: 'true',
  CLEAN_OUTPUT: 'true',
  CONTENT_FILTER: 'true',
  STREAMING: 'true',
  RETRY_ENABLED: 'true',
  RETRY_MAX_ATTEMPTS: '3',
  LOG_LEVEL: 'info',
  LOG_MAX_ENTRIES: '1000',
};

/**
 * Strip JSONC comments (// line comments and /* block comments *\/) so the result
 * is valid JSON that JSON.parse can handle.
 */
function stripJsonc(raw) {
  // Remove block comments first, then line comments
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const idx = l.indexOf('//');
      return idx === -1 ? l : l.slice(0, idx);
    })
    .join('\n')
    .replace(/,\s*([}\]])/g, '$1'); // trailing commas
}

async function ask(query, def) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${query} [${def}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || def);
    });
  });
}

async function main() {
  // Skip interactive prompts when piped (e.g. curl | bash)
  const useDefaults = !process.stdin.isTTY;

  // Read existing config, tolerating JSONC (// comments) from config.example.jsonc
  let config = {};
  let configExisted = false;
  if (existsSync(CONFIG_PATH)) {
    configExisted = true;
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    try {
      config = JSON.parse(stripJsonc(raw));
    } catch {
      // config was corrupted (e.g. JSONC copied as .json) — will recreate with defaults
    }
  }

  // If running non-interactively and config already exists, do nothing
  if (useDefaults && configExisted && Object.keys(config).length > 0) {
    return;
  }

  if (useDefaults) {
    console.log('  Non-interactive install — using defaults. Edit config.json later.\n');
  }

  // Lazily import readline only when interactive
  let port = DEFAULTS.PORT;
  let host = DEFAULTS.HOST;
  let apiKey = DEFAULTS.API_KEY;
  let dashboard = DEFAULTS.DASHBOARD;
  let browser = DEFAULTS.BROWSER;

  if (useDefaults) {
    port = config.PORT || DEFAULTS.PORT;
    host = config.HOST || DEFAULTS.HOST;
    apiKey = config.API_KEY || DEFAULTS.API_KEY;
    dashboard = config.DASHBOARD || DEFAULTS.DASHBOARD;
    browser = config.BROWSER || DEFAULTS.BROWSER;
  } else {
    port = await ask('Server port', config.PORT || DEFAULTS.PORT);
    host = await ask('Bind host', config.HOST || DEFAULTS.HOST);
    apiKey = await ask('API key (leave empty for no auth)', config.API_KEY || DEFAULTS.API_KEY);
    dashboard = await ask('Enable dashboard (true/false)', config.DASHBOARD || DEFAULTS.DASHBOARD);
    browser = await ask('Browser engine (chromium/firefox/chrome/edge)', config.BROWSER || DEFAULTS.BROWSER);
  }

  const newConfig = Object.assign({}, DEFAULTS, config, {
    PORT: port,
    HOST: host,
    API_KEY: apiKey,
    DASHBOARD: dashboard,
    BROWSER: browser,
  });

  writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2) + '\n');
  if (!useDefaults) console.log(`\n  ✅ Config saved to ${CONFIG_PATH}`);
  console.log('\n  Run \`npm start\` to launch Qwen Gate.\n');
}

main().catch((e) => {
  // Fail silently in non-interactive mode (postinstall, qg auto-install)
  if (process.stdin.isTTY) {
    console.error('Setup failed:', e.message);
    process.exit(1);
  }
});
