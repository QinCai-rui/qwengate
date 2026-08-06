import { existsSync, readFileSync } from 'fs';
import { Hono } from 'hono';
import { resolve } from 'path';
import { getAccountCount, getAccountStats, getAllAccountEmails, getAvailableCount, initAuth } from '../../services/auth.ts';
import { config, isValidKey, type ConfigSchema } from '../../services/configService.ts';
import { logStore } from '../../services/logStore.ts';
import { monitorStore } from '../../services/monitorStore.ts';

import { configureAccount, deleteAllChats } from '../../services/qwen.ts';
import { sessionPool } from '../../services/sessionPool.ts';
import { checkApiKeyAuth, clearSessionCookieHeader, hasValidDashboardSession, safeCompare, sessionCookieHeader } from '../../utils/auth.ts';
import { projectPath } from '../../utils/paths.ts';
import { APP_VERSION } from '../../utils/version.ts';
import { accountsHtml } from './accounts.ts';
import { loginHtml } from './login.ts';
import { monitorHtml } from './monitor.ts';
import { networkHtml } from './network.ts';
import { overviewHtml } from './overview.ts';
import { settingsHtml } from './settings.ts';

const serveHtml = (html: string) => (c: any) => {
  // Dashboard HTML pages are admin UI, gated behind a login session cookie
  // (issue #45). A dashboard password is always configured (default
  // admin/123456), so the gate is always active. Without a valid session,
  // redirect to /dashboard/login.
  if (!hasValidDashboardSession(c)) {
    return c.redirect('/dashboard/login');
  }
  const darkMode = config.get('DARK_MODE') === 'true';
  // NOTE: no credentials are ever injected into the page. Auth flows
  // through the HttpOnly cookie set at /dashboard/login.
  const scriptInjection = `<script>\nwindow.APP_VERSION = ${JSON.stringify(APP_VERSION)};\nwindow.DARK_MODE = ${JSON.stringify(darkMode)};\n</script>\n<link rel="icon" type="image/svg+xml" href="/dashboard/static/logo.svg">\n`;
  // Apply dark-mode class on <html> server-side to prevent flash on page navigation
  let output = html.replace(/(<script\b)/, scriptInjection + '$1');
  if (darkMode) {
    output = output.replace('<html lang="en">', '<html lang="en" class="dark-mode">');
  }
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:;",
  );
  return c.html(output);
};

function dashboardStaticHandler(c: any) {
  const file = c.req.param('file');
  if (!/^[a-z0-9_-]+\.(css|js|svg)$/i.test(file)) return c.json({ error: 'Invalid file' }, 400);
  const DASHBOARD_STATIC = projectPath('src', 'routes', 'dashboard', 'public');
  const filePath = resolve(DASHBOARD_STATIC, file);
  if (!filePath.startsWith(DASHBOARD_STATIC) || !existsSync(filePath)) return c.json({ error: 'Not found' }, 404);
  const mime: Record<string, string> = { css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml' };
  const ext = file.split('.').pop() || '';
  const contentType = mime[ext] || 'application/octet-stream';
  return c.text(readFileSync(filePath, 'utf-8'), 200, { 'Content-Type': contentType });
}

function healthHandler(c: any) {
  const poolOk = getAvailableCount() > 0;
  return c.json(
    {
      status: poolOk ? 'ok' : 'degraded',
      pool: poolOk,
      accounts: { total: getAccountCount(), available: getAvailableCount() },
      uptime: process.uptime(),
    },
    200,
  );
}

async function accountsReloadHandler(c: any) {
  try {
    await initAuth(async (email) => {
      logStore.log('info', 'account', `Reloading ${email}`);
      await configureAccount(email);
    });
    logStore.log('info', 'auth', 'Accounts reloaded');
    return c.json({ ok: true });
  } catch (err: any) {
    logStore.log('error', 'auth', `Reload failed: ${err.message}`);
    return c.json({ error: err.message }, 500);
  }
}

async function deleteAllChatsHandler(c: any) {
  const emails = getAllAccountEmails();
  if (!emails || emails.length === 0) return c.json({ error: 'No accounts configured' }, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let deleted = 0;
      const errors: string[] = [];
      const maskEmail = (e: string) => {
        const at = e.indexOf('@');
        return at > 0 ? e.slice(0, Math.min(at, 3)) + '***' + e.slice(at) : e;
      };
      for (const email of emails) {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'progress', email: maskEmail(email), status: 'deleting' })}\n\n`),
          );
          await deleteAllChats(email);
          deleted++;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'progress', email: maskEmail(email), status: 'done' })}\n\n`));
        } catch (err: any) {
          errors.push(`${maskEmail(email)}: ${err.message}`);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'progress', email: maskEmail(email), status: 'error', error: err.message })}\n\n`,
            ),
          );
        }
      }
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: 'result', ok: true, deleted, total: emails.length, errors: errors.length ? errors : undefined })}\n\n`,
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

function sanitizeLogEntry(entry: any): any {
  const sanitized = { ...entry };

  // Mask email addresses (keep first 3 chars)
  if (sanitized.account) {
    const [local, domain] = sanitized.account.split('@');
    sanitized.account = local.substring(0, 3) + '***@' + (domain || '***');
  }

  // Mask prompt content that might contain credentials
  if (sanitized.input?.messages) {
    sanitized.input = {
      ...sanitized.input,
      messages: sanitized.input.messages.map((m: any) => {
        if (typeof m.content === 'string' && m.content.length > 200) {
          return { ...m, content: m.content.substring(0, 200) + '...[truncated]' };
        }
        return m;
      }),
    };
  }

  // Truncate long text fields that may contain sensitive data
  for (const field of ['rawFullContent', 'processedApiOutput', 'remainingText', 'amplificationTriggeredInput', 'rawResponse', 'input']) {
    if (typeof sanitized[field] === 'string' && sanitized[field].length > 500) {
      sanitized[field] = sanitized[field].substring(0, 500) + '...[truncated]';
    }
  }

  // Truncate raw_output and proccessed_output
  if (sanitized.raw_output && sanitized.raw_output.length > 1000) {
    sanitized.raw_output = sanitized.raw_output.substring(0, 1000) + '...[truncated]';
  }
  if (sanitized.proccessed_output && sanitized.proccessed_output.length > 1000) {
    sanitized.proccessed_output = sanitized.proccessed_output.substring(0, 1000) + '...[truncated]';
  }
  // Truncate thinking_content
  if (sanitized.thinking_content && sanitized.thinking_content.length > 2000) {
    sanitized.thinking_content = sanitized.thinking_content.substring(0, 2000) + '...[truncated]';
  }

  return sanitized;
}

function systemLogsHandler(c: any) {
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const category = c.req.query('category');
  const minLevel = c.req.query('level') as 'debug' | 'info' | 'warn' | 'error' | undefined;
  const logs = logStore.getSystemLogs({ limit, category, minLevel });
  return c.json(logs.map(sanitizeLogEntry));
}

function modelHealthHandler(c: any) {
  return c.json(logStore.getAllModelHealth());
}

function monitorHandler(c: any) {
  try {
    return c.json(monitorStore.getSummary());
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}

function logStreamHandler(c: any) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let alive = true;
        const safeEnqueue = (data: string): boolean => {
          if (!alive) return false;
          try {
            controller.enqueue(encoder.encode(data));
            return true;
          } catch {
            alive = false;
            return false;
          }
        };

        for (const entry of logStore.getRecent(50)) {
          if (!safeEnqueue(`data: ${JSON.stringify(sanitizeLogEntry(entry))}\n\n`)) break;
        }

        const heartbeat = setInterval(() => {
          if (!alive) {
            clearInterval(heartbeat);
            return;
          }
          if (!safeEnqueue(': ping\n\n')) {
            clearInterval(heartbeat);
          }
        }, 15000);
        heartbeat.unref();

        const unsub = logStore.subscribe((entry) => {
          if (!safeEnqueue(`data: ${JSON.stringify(sanitizeLogEntry(entry))}\n\n`)) {
            unsub();
            clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              /* stream already lost */
            }
          }
        });

        const signal = c.req.raw?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            alive = false;
            unsub();
            clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              /* stream already lost */
            }
          });
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
  );
}

function logJsonHandler(c: any) {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const entries = logStore.getRecent(Math.max(1, Math.min(limit, 500)));
  const serialized = entries.map((e) => {
    const toolCalls = (e.parsedToolCalls || []).map((tc) => {
      let args: unknown = tc.args;
      try {
        args = JSON.parse(tc.args);
      } catch {
        /* keep as string */
      }
      return { name: tc.name, arguments: args };
    });
    return {
      id: e.id,
      timestamp: e.timestamp,
      account: e.accountEmail,
      model: e.model,
      finish_reason: e.finalResponse?.finishReason || null,
      stream: e.stream,
      latency_ms: e.latency_ms,
      thinking_content: e.reasoningContent || '',
      raw_output: e.rawFullContent || '',
      proccessed_output: e.processedApiOutput || '',
      tool_call_count: toolCalls.length,
      tool_calls: toolCalls,
      errors: e.errors || [],
      chunks: e.qwenRawChunks || [],
      input: e.clientRequest || {},
    };
  });
  return c.json(serialized.map(sanitizeLogEntry));
}

function requireApiKey(c: any, next: () => Promise<void>) {
  // A valid dashboard session cookie also authorizes data endpoints — the
  // browser flow (login → cookie) then works for every fetch without the
  // front-end ever holding the raw key.
  const denied = checkApiKeyAuth(c);
  if (!denied) return next();
  if (hasValidDashboardSession(c)) return next();
  return denied;
}

const SECRET_CONFIG_KEYS = ['API_KEY', 'DASHBOARD_PASSWORD'];

function stripSecrets(all: ConfigSchema): Record<string, string> {
  return Object.fromEntries(Object.entries(all).filter(([k]) => !SECRET_CONFIG_KEYS.includes(k)));
}

export function registerDashboardRoutes(app: Hono): void {
  // ── Login / logout (issue #45) ──
  // Login page is always reachable (it IS the gate). Everything else under
  // /dashboard requires a valid session cookie.
  app.get('/dashboard/login', (c) => {
    if (hasValidDashboardSession(c)) {
      return c.redirect('/dashboard');
    }
    const darkMode = config.get('DARK_MODE') === 'true';
    const host = config.get('HOST') || '';
    const port = config.get('PORT') || '26405';
    let output = loginHtml
      .replace('__HOST__', JSON.stringify(host))
      .replace('__PORT__', JSON.stringify(port));
    if (darkMode) {
      output = output.replace('<html lang="en">', '<html lang="en" class="dark-mode">');
    }
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:;",
    );
    return c.html(output);
  });
  app.post('/dashboard/login', async (c) => {
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const submittedUser = typeof body.username === 'string' ? body.username : '';
    const submittedPass = typeof body.password === 'string' ? body.password : '';
    const expectedUser = config.get('DASHBOARD_USER') || 'admin';
    const expectedPass = config.get('DASHBOARD_PASSWORD') || '123456';
    if (!safeCompare(submittedUser.trim(), expectedUser) || !safeCompare(submittedPass, expectedPass)) {
      return c.json({ error: 'Invalid username or password' }, 401);
    }
    c.header('Set-Cookie', sessionCookieHeader());
    return c.json({ ok: true });
  });
  app.post('/dashboard/logout', (c) => {
    c.header('Set-Cookie', clearSessionCookieHeader());
    return c.json({ ok: true });
  });

  app.get('/dashboard', serveHtml(overviewHtml));
  app.get('/dashboard/accounts', serveHtml(accountsHtml));
  app.get('/dashboard/usage', (c) => c.redirect('/dashboard/monitor'));
  app.get('/dashboard/network', serveHtml(networkHtml));
  app.get('/dashboard/settings', serveHtml(settingsHtml));
  app.get('/dashboard/monitor', serveHtml(monitorHtml));

  app.get('/dashboard/static/:file', dashboardStaticHandler);

  app.get('/', (c) => c.redirect('/dashboard'));
  app.get('/health', healthHandler);
  app.get(
    '/accounts',
    async (c, next) => requireApiKey(c, next),
    (c) => {
      return c.json(getAccountStats());
    },
  );
  app.get(
    '/pool/stats',
    async (c, next) => requireApiKey(c, next),
    (c) => {
      return c.json(sessionPool.getStats());
    },
  );

  app.post(
    '/admin/accounts/reload',
    async (c, next) => requireApiKey(c, next),
    accountsReloadHandler,
  );
  app.post(
    '/dashboard/accounts/delete-all-chats',
    async (c, next) => requireApiKey(c, next),
    deleteAllChatsHandler,
  );

  app.get('/system/logs', async (c, next) => requireApiKey(c, next), systemLogsHandler);
  app.get('/metrics/model-health', async (c, next) => requireApiKey(c, next), modelHealthHandler);
  app.get('/metrics/monitor', async (c, next) => requireApiKey(c, next), monitorHandler);

  app.get('/log', (c) => c.redirect('/dashboard'));

  app.patch(
    '/api/accounts/:email',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const body = await c.req.json();
        const { setAccountDisabled } = await import('../../services/accountManager.ts');
        setAccountDisabled(c.req.param('email'), body.disabled === true);
        return c.json({ ok: true });
      } catch (err: any) {
        return c.json({ error: err.message }, 404);
      }
    },
  );

  // ── Bulk account import (issue #46) ──
  // Accepts pipe format:  "email|password\nemail|password"
  // or JSON format:       { "accounts": [{"email","password"}, ...] }
  // or array format:      [{ "email","password" }, ...]
  app.post(
    '/api/accounts/import',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const body = await c.req.json();
        let entries: Array<{ email: string; password: string }> = [];

        if (Array.isArray(body)) {
          entries = body;
        } else if (body && body.format === 'pipe' && typeof body.data === 'string') {
          entries = body.data
            .split(/\r?\n/)
            .map((line: string) => line.trim())
            .filter(Boolean)
            .map((line: string) => {
              const sep = line.indexOf('|');
              if (sep < 0) return { email: line, password: '' };
              return { email: line.slice(0, sep).trim(), password: line.slice(sep + 1).trim() };
            });
        } else if (body && Array.isArray(body.accounts)) {
          entries = body.accounts;
        } else {
          return c.json({ error: 'Invalid body: expected {format:"pipe",data} or {accounts:[...]}' }, 400);
        }

        if (entries.length === 0) return c.json({ error: 'No accounts provided' }, 400);
        if (entries.length > 500) return c.json({ error: 'Batch too large (max 500)' }, 400);

        const { bulkAddAccounts } = await import('../../services/accountManager.ts');
        const result = await bulkAddAccounts(entries);
        return c.json(result);
      } catch (err: any) {
        return c.json({ error: err.message || 'import failed' }, 500);
      }
    },
  );

  app.get('/log/json', async (c, next) => requireApiKey(c, next), logJsonHandler);
  app.get('/log/stream', async (c, next) => requireApiKey(c, next), logStreamHandler);
  app.get(
    '/metrics/uptime',
    async (c, next) => requireApiKey(c, next),
    (c) => {
      return c.json({ uptimeSeconds: logStore.getUptimeSeconds() });
    },
  );

  app.get(
    '/api/config',
    async (c, next) => requireApiKey(c, next),
    (c) => {
      const all = config.getAll();
      const safe = stripSecrets(all);
      // Never echo secrets back. Expose only whether they are set so the UI
      // can render "leave blank to keep" instead of an always-empty field
      // (which read as "it didn't save" — issue #51).
      const apiKey = all.API_KEY;
      const dashPass = all.DASHBOARD_PASSWORD;
      return c.json({ config: safe, apiKeySet: !!apiKey, dashboardPasswordSet: !!dashPass });
    },
  );

  app.put(
    '/api/config',
    async (c, next) => requireApiKey(c, next),
    async (c) => {
      try {
        const body = await c.req.json();
        let changed = false;
        for (const key of Object.keys(body)) {
          if (key === 'API_KEY' || key === 'DASHBOARD_PASSWORD') {
            // Secrets: ''/undefined means "keep current", a non-empty string
            // means "set new", explicit null means "clear". Never echoed back.
            if (body[key] === null) {
              if (config.get(key as keyof ConfigSchema)) {
                config.set(key as keyof ConfigSchema, '');
                changed = true;
              }
            } else if (typeof body[key] === 'string' && body[key].trim() !== '') {
              config.set(key as keyof ConfigSchema, body[key].trim());
              changed = true;
            }
          } else if (typeof body[key] === 'string' && isValidKey(key)) {
            config.set(key, body[key]);
            changed = true;
          }
        }
        if (changed) config.save();
        const all = config.getAll();
        const safe = stripSecrets(all);
        return c.json({ config: safe, apiKeySet: !!all.API_KEY, dashboardPasswordSet: !!all.DASHBOARD_PASSWORD });
      } catch {
        return c.json({ error: 'invalid request body' }, 400);
      }
    },
  );
}
