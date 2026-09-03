import { existsSync, readFileSync } from 'fs';
import { Hono } from 'hono';
import { resolve } from 'path';
import {
  getAccountCount,
  getAccountStats,
  getAccounts,
  getAllAccountEmails,
  getAvailableCount,
  reloadAccounts,
} from '../../services/auth.ts';
import { config, isValidKey } from '../../services/configService.ts';
import {
  authenticateDashboard,
  clearDashboardCookie,
  dashboardCredentialsConfigured,
  destroyDashboardSession,
  isDashboardAuthenticated,
  requireApiOrDashboardAuth,
  requireDashboardAuth,
  setDashboardCookie,
} from '../../services/dashboardAuth.ts';
import { logStore } from '../../services/logStore.ts';
import { monitorStore } from '../../services/monitorStore.ts';

import { configureAccount, deleteAllChats } from '../../services/qwen.ts';
import { sessionPool } from '../../services/sessionPool.ts';
import { projectPath } from '../../utils/paths.ts';
import { APP_VERSION } from '../../utils/version.ts';
import { accountsHtml } from './accounts.ts';
import { monitorHtml } from './monitor.ts';
import { networkHtml } from './network.ts';
import { overviewHtml } from './overview.ts';
import { settingsHtml } from './settings.ts';
import { usageHtml } from './usage.ts';

const serveHtml = (html: string) => (c: any) => {
  const darkMode = config.get('DARK_MODE') === 'true';
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
  c.header('Cache-Control', 'no-store');
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

const dashboardLoginHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Qwen Gate Admin Login</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101318;color:#eef2f7;font:16px system-ui,sans-serif}.card{width:min(380px,calc(100vw - 40px));padding:32px;border:1px solid #303744;border-radius:12px;background:#171b22;box-shadow:0 18px 50px #0006}h1{margin:0 0 8px;font-size:1.35rem}p{color:#aab4c2;margin:0 0 24px}label{display:block;margin:16px 0 6px;color:#cbd5e1}input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #475569;border-radius:6px;background:#0f141b;color:#fff;font:inherit}button{width:100%;margin-top:24px;padding:11px;border:0;border-radius:6px;background:#5b8cff;color:white;font-weight:700;font:inherit;cursor:pointer}.error{min-height:1.25em;margin-top:14px;color:#ff8c8c}</style></head>
<body><main class="card"><h1>Qwen Gate Admin</h1><p>Sign in to access the local administration dashboard.</p>
<form id="loginForm" method="post" action="/dashboard/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button><div class="error" aria-live="polite"></div></form></main><script>document.getElementById('loginForm').addEventListener('submit',async function(e){e.preventDefault();var form=e.currentTarget,err=form.querySelector('.error'),button=form.querySelector('button');button.disabled=true;err.textContent='';try{var res=await fetch(form.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.username.value,password:form.password.value}),credentials:'same-origin'});if(res.ok){location.href='/dashboard';}else{err.textContent=await res.text();}}catch(_){err.textContent='Login failed';}button.disabled=false;});</script></body></html>`;

const failedLogins = new Map<string, { count: number; blockedUntil: number; lastAttempt: number }>();

function pruneFailedLogins(now = Date.now()): void {
  for (const [key, attempt] of failedLogins) {
    if (now - attempt.lastAttempt > 15 * 60_000) failedLogins.delete(key);
  }
  while (failedLogins.size > 10_000) {
    const first = failedLogins.keys().next().value;
    if (!first) break;
    failedLogins.delete(first);
  }
}

function loginClientKey(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('user-agent') || 'unknown';
}

function dashboardLoginHandler(c: any) {
  if (isDashboardAuthenticated(c)) return c.redirect('/dashboard');
  c.header('Cache-Control', 'no-store');
  return c.html(dashboardLoginHtml);
}

async function dashboardLoginSubmit(c: any) {
  if (!dashboardCredentialsConfigured()) return c.text('Dashboard credentials are not configured', 503);
  pruneFailedLogins();

  let username = '';
  let password = '';
  try {
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await c.req.json();
      username = typeof body?.username === 'string' ? body.username : '';
      password = typeof body?.password === 'string' ? body.password : '';
    } else {
      const body = await c.req.parseBody();
      username = typeof body.username === 'string' ? body.username : '';
      password = typeof body.password === 'string' ? body.password : '';
    }
  } catch {
    return c.text('Invalid login request', 400);
  }

  // Key valid-username attempts independently of forwarded headers so a client
  // cannot bypass the lockout by spoofing X-Forwarded-For.
  const key = username.trim() ? `username:${username.trim().toLowerCase()}` : `client:${loginClientKey(c)}`;
  const attempt = failedLogins.get(key);
  if (attempt && attempt.blockedUntil > Date.now()) return c.text('Too many login attempts. Try again later.', 429);

  const token = authenticateDashboard(username, password);
  if (!token) {
    const count = (attempt?.count || 0) + 1;
    failedLogins.set(key, { count, blockedUntil: count >= 5 ? Date.now() + 60_000 : 0, lastAttempt: Date.now() });
    return c.text('Invalid username or password', 401);
  }
  failedLogins.delete(key);
  setDashboardCookie(c, token);
  return c.redirect('/dashboard');
}

function dashboardLogoutHandler(c: any) {
  destroyDashboardSession(c);
  clearDashboardCookie(c);
  return c.redirect('/dashboard/login');
}

async function accountsReloadHandler(c: any) {
  try {
    await reloadAccounts();
    for (const account of getAccounts()) {
      if (account.state?.token && account.startupStatus !== 'ready') {
        logStore.log('info', 'account', `Reloading ${account.email}`);
        await configureAccount(account.email);
        account.startupStatus = 'ready';
      }
    }
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
  const parsedLimit = parseInt(c.req.query('limit') || '100', 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 500)) : 100;
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

export function registerDashboardRoutes(app: Hono): void {
  app.get('/dashboard/login', dashboardLoginHandler);
  app.post('/dashboard/login', dashboardLoginSubmit);
  app.post('/dashboard/logout', requireDashboardAuth, dashboardLogoutHandler);
  app.get('/dashboard', requireDashboardAuth, serveHtml(overviewHtml));
  app.get('/dashboard/accounts', requireDashboardAuth, serveHtml(accountsHtml));
  app.get('/dashboard/usage', requireDashboardAuth, serveHtml(usageHtml));
  app.get('/dashboard/network', requireDashboardAuth, serveHtml(networkHtml));
  app.get('/dashboard/settings', requireDashboardAuth, serveHtml(settingsHtml));
  app.get('/dashboard/monitor', requireDashboardAuth, serveHtml(monitorHtml));

  app.get('/dashboard/static/:file', dashboardStaticHandler);

  app.get('/', (c) => c.redirect('/dashboard'));
  app.get('/health', healthHandler);
  app.get('/accounts', requireDashboardAuth, (c) => {
    return c.json(getAccountStats());
  });
  app.get('/pool/stats', requireDashboardAuth, (c) => {
    return c.json(sessionPool.getStats());
  });

  app.post('/admin/accounts/reload', requireDashboardAuth, accountsReloadHandler);
  app.post('/dashboard/accounts/delete-all-chats', requireDashboardAuth, deleteAllChatsHandler);

  app.get('/system/logs', requireDashboardAuth, systemLogsHandler);
  app.get('/metrics/model-health', requireDashboardAuth, modelHealthHandler);
  app.get('/metrics/monitor', requireDashboardAuth, monitorHandler);

  app.get('/log', (c) => c.redirect('/dashboard'));

  app.get('/log/json', requireDashboardAuth, logJsonHandler);
  app.get('/log/stream', requireDashboardAuth, logStreamHandler);
  app.get('/metrics/uptime', requireDashboardAuth, (c) => {
    return c.json({ uptimeSeconds: logStore.getUptimeSeconds() });
  });

  app.get('/api/config', requireApiOrDashboardAuth, (c) => {
    const all = config.getAll();
    const safe = { ...all, API_KEY: '', DASHBOARD_PASSWORD: '' };
    return c.json({ config: safe });
  });

  app.put('/api/config', requireApiOrDashboardAuth, async (c) => {
    try {
      const body = await c.req.json();
      let changed = false;
      for (const key of Object.keys(body)) {
        if (typeof body[key] === 'string' && isValidKey(key) && (key !== 'DASHBOARD_PASSWORD' || body[key].length >= 12)) {
          config.set(key, body[key]);
          changed = true;
        }
      }
      if (changed) config.save();
      const all = config.getAll();
      const safe = { ...all, API_KEY: '', DASHBOARD_PASSWORD: '' };
      return c.json({ config: safe });
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }
  });
}
