import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

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

function ask(query, def, useDefaults) {
  if (useDefaults) return def;
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

  if (useDefaults) {
    console.log('  Non-interactive install — using defaults. Edit config.json later.\n');
  }

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (!useDefaults) {
        console.log(`  Existing config found at ${CONFIG_PATH}`);
        console.log('  Press Enter to keep current values.\n');
      }
    } catch {
      console.log('  Corrupted config.json — will recreate.\n');
    }
  }

  const port = await ask('Server port', config.PORT || DEFAULTS.PORT, useDefaults);
  const host = await ask('Bind host', config.HOST || DEFAULTS.HOST, useDefaults);
  const apiKey = await ask('API key (leave empty for no auth)', config.API_KEY || DEFAULTS.API_KEY, useDefaults);
  const dashboard = await ask('Enable dashboard (true/false)', config.DASHBOARD || DEFAULTS.DASHBOARD, useDefaults);
  const browser = await ask('Browser engine (chromium/firefox/chrome/edge)', config.BROWSER || DEFAULTS.BROWSER, useDefaults);

  const newConfig = Object.assign({}, DEFAULTS, config, {
    PORT: port,
    HOST: host,
    API_KEY: apiKey,
    DASHBOARD: dashboard,
    BROWSER: browser,
  });

  writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2) + '\n');
  if (!useDefaults) console.log(`\n  ✅ Config saved to ${CONFIG_PATH}`);
  console.log('\n  Run `npm start` to launch Qwen Gate.\n');
}

main().catch((e) => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
