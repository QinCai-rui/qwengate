// Login page. Served by the /dashboard/login route, which injects:
//   __DARK_MODE__   'true' | 'false'   → toggles html.dark-mode class
//   __HOST__        configured HOST (or '')
//   __PORT__        configured PORT (or '26405')
// The page links the shared clay theme (shared.css) so light/dark mode
// matches the rest of the dashboard exactly.
export const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QwenGate — Login</title>
  <link rel="icon" type="image/svg+xml" href="/dashboard/static/logo.svg">
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .login-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 40px 36px;
      width: 100%;
      max-width: 400px;
      box-shadow: var(--clay-shadow);
    }
    .login-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .login-logo svg { color: var(--accent); }
    .login-title { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.01em; font-family: var(--display); }
    .login-desc { color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 28px; line-height: 1.5; }
    .login-field { margin-bottom: 20px; }
    .login-field label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }
    .login-field input {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 0.9375rem;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .login-field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .login-field input::placeholder { color: var(--text-secondary); opacity: 0.7; }
    .login-error {
      display: none;
      background: var(--danger-soft);
      border: 1px solid var(--danger);
      color: var(--danger);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
      font-size: 0.8125rem;
      margin-bottom: 16px;
    }
    .login-error.show { display: block; }
    .login-btn {
      width: 100%;
      padding: 11px 16px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 0.9375rem;
      font-weight: 600;
      font-family: var(--font);
      cursor: pointer;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .login-btn:hover { background: var(--accent); filter: brightness(1.08); box-shadow: var(--clay-shadow-sm); }
    .login-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .login-hint {
      margin-top: 18px;
      text-align: center;
      color: var(--text-secondary);
      font-size: 0.75rem;
      line-height: 1.5;
    }
    .login-hint code {
      font-family: var(--mono);
      background: var(--bg-elevated);
      padding: 1px 6px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="login-logo">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <span class="login-title">QwenGate</span>
    </div>
    <p class="login-desc">This dashboard is protected. Enter your credentials to continue.</p>
    <div class="login-error" id="loginError"></div>
    <form id="loginForm">
      <div class="login-field">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" placeholder="admin" autocomplete="username" autofocus required>
      </div>
      <div class="login-field">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" placeholder="••••••" autocomplete="current-password" required>
      </div>
      <button type="submit" class="login-btn" id="loginBtn">Unlock Dashboard</button>
    </form>
    <p class="login-hint">Default credentials: <code>admin</code> / <code>123456</code> — change them in config.json.</p>
    <p class="login-hint" id="serverInfo"></p>
  </div>
  <script>
    // Host/port injected from server config so the login page (served before
    // auth) always knows where it lives.
    var APP_HOST = __HOST__ || window.location.hostname;
    var APP_PORT = __PORT__ || window.location.port || '26405';
    document.getElementById('serverInfo').textContent = 'Server: ' + APP_HOST + ':' + APP_PORT;

    document.getElementById('loginForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = document.getElementById('loginBtn');
      var err = document.getElementById('loginError');
      btn.disabled = true;
      btn.textContent = 'Checking...';
      err.classList.remove('show');
      try {
        var res = await fetch('/dashboard/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });
        if (res.ok) {
          window.location.href = '/dashboard';
        } else {
          var data = await res.json().catch(function () { return {}; });
          err.textContent = data.error || 'Invalid credentials';
          err.classList.add('show');
          btn.disabled = false;
          btn.textContent = 'Unlock Dashboard';
        }
      } catch (ex) {
        err.textContent = 'Network error — please try again.';
        err.classList.add('show');
        btn.disabled = false;
        btn.textContent = 'Unlock Dashboard';
      }
    });
  </script>
</body>
</html>`;
