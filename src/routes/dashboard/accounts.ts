export const accountsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — Accounts</title>
<script src="/api/env.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Montserrat:wght@400;500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap');
:root {
  --bg-primary: #F5F1EA;
  --bg-card: #E9E2D6;
  --bg-elevated: #DDD4C6;
  --border: #C9BFAE;
  --text-primary: #1a1615;
  --text-secondary: #8a7f6f;
  --text-display: #4a4540;
  --accent: #5E9D5C;
  --accent-soft: rgba(94, 157, 92, 0.2);
  --success: #3D8B3D;
  --success-soft: rgba(61, 139, 61, 0.15);
  --warning: #C8983A;
  --warning-soft: rgba(200, 152, 58, 0.15);
  --danger: #C96B6B;
  --danger-soft: rgba(201, 107, 107, 0.15);
  --radius: 16px;
  --radius-sm: 10px;
  --sidebar-width: 220px;
  --font: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --display: 'Poppins', sans-serif;
  --mono: 'JetBrains Mono', 'SF Mono', Monaco, Consolas, monospace;
  --clay-shadow: 6px 6px 12px rgba(0,0,0,0.06), -2px -2px 6px rgba(255,255,255,0.5);
  --clay-shadow-sm: 3px 3px 6px rgba(0,0,0,0.04), -1px -1px 3px rgba(255,255,255,0.4);
  --clay-puff: inset 2px 2px 4px rgba(255,255,255,0.6), inset -2px -2px 4px rgba(0,0,0,0.04);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--font);background:var(--bg-primary);color:var(--text-primary);line-height:1.5;min-height:100vh}

/* Layout */
.dashboard-layout{display:flex;min-height:100vh}
.sidebar{width:var(--sidebar-width);min-width:var(--sidebar-width);background:var(--bg-card);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100}
.sidebar-header{padding:20px 16px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px}
.sidebar-header h1{font-size:1rem;font-family:var(--display);font-weight:700;color:var(--text-primary);letter-spacing:-0.01em}
.sidebar-nav{flex:1;padding:8px;display:flex;flex-direction:column;gap:2px}
.sidebar-footer{padding:14px 16px;border-top:1px solid var(--border);font-size:0.75rem;color:var(--text-secondary);font-family:var(--mono)}
.nav-link{display:flex;align-items:center;gap:10px;padding:8px 12px;border:none;border-radius:var(--radius-sm);background:transparent;color:var(--text-secondary);font-size:0.8125rem;font-weight:500;cursor:pointer;transition:all 0.15s;white-space:nowrap;font-family:var(--font);width:100%;text-align:left;text-decoration:none}
.nav-link:hover{color:var(--text-primary);background:var(--bg-elevated);box-shadow:var(--clay-puff)}
.nav-link.active{background:var(--accent);color:#fff;box-shadow:var(--clay-shadow-sm)}
.nav-link svg{flex-shrink:0}
.live-indicator{display:flex;align-items:center;gap:6px;font-size:0.7rem;color:var(--success);text-transform:uppercase;letter-spacing:0.05em;font-weight:500}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;display:inline-block}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.85)}}
.main-content{flex:1;margin-left:var(--sidebar-width);padding:24px;width:calc(100% - var(--sidebar-width))}

/* Header */
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px}
.page-header h1{font-size:1.35rem;font-family:var(--display);font-weight:700;letter-spacing:-0.02em;color:var(--text-display)}

/* Panel */
.panel{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:16px;box-shadow:var(--clay-shadow),var(--clay-puff)}
.panel-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}
.panel-title{font-size:0.875rem;font-family:var(--display);font-weight:600;color:var(--accent);display:flex;align-items:center;gap:8px}
.panel-body{padding:16px}

/* Form */
.account-form{display:flex;gap:8px;flex-wrap:wrap}
.account-input{flex:1;min-width:150px;padding:8px 12px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:0.8125rem;font-family:var(--font);box-shadow:var(--clay-puff)}
.account-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft),var(--clay-puff)}
.account-btn{padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);font-size:0.8125rem;font-weight:500;cursor:pointer;transition:opacity 0.2s;font-family:var(--font);white-space:nowrap;box-shadow:var(--clay-shadow-sm)}
.account-btn:hover{opacity:0.9}
.account-btn.danger{background:var(--danger)}
.account-btn.primary{background:var(--accent)}
.account-btn.small{padding:4px 8px;font-size:0.75rem}
.account-btn:disabled{opacity:0.5;cursor:not-allowed}

/* Table */
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:0.8125rem}
thead th{text-align:left;padding:10px 8px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap}
tbody td{padding:10px 8px;border-bottom:1px solid var(--border);color:var(--text-primary);vertical-align:middle;word-break:break-all}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--bg-elevated)}

/* Auth Status Dot */
.auth-status{display:flex;align-items:center;gap:6px}
.auth-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.auth-dot.live{background:var(--success);box-shadow:0 0 6px var(--success-soft)}
.auth-dot.expired{background:var(--danger)}
.auth-dot.throttled{background:var(--warning)}
.auth-dot.unknown{background:var(--text-secondary)}

/* Badges */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:500;white-space:nowrap;gap:4px;line-height:1.4;box-shadow:var(--clay-shadow-sm)}
.badge-success{background:var(--success-soft);color:var(--success)}
.badge-danger{background:var(--danger-soft);color:var(--danger)}
.badge-warning{background:var(--warning-soft);color:var(--warning)}
.badge-accent{background:var(--accent-soft);color:var(--accent)}
.badge-neutral{background:var(--bg-elevated);color:var(--text-secondary)}

/* Actions cell */
.action-cell{display:flex;gap:6px;flex-wrap:nowrap}

/* Error Display */
.error-box{display:none;background:var(--danger-soft);color:var(--danger);padding:8px 12px;border-radius:var(--radius);font-size:0.8125rem;margin-bottom:12px}

/* Toast */
.toast-container{position:fixed;bottom:20px;right:20px;z-index:1000;display:flex;flex-direction:column;gap:8px}
.toast{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;box-shadow:var(--clay-shadow);animation:slideIn 0.3s ease;font-size:0.8125rem;max-width:380px}
.toast.success{border-left:3px solid var(--success)}
.toast.error{border-left:3px solid var(--danger)}
.toast.warning{border-left:3px solid var(--warning)}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}

/* Confirmation Modal */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:2000;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:24px;max-width:420px;width:90%;box-shadow:var(--clay-shadow)}
.modal h3{margin:0 0 8px;font-size:1rem;font-family:var(--display)}
.modal p{margin:0 0 20px;font-size:0.875rem;color:var(--text-secondary)}
.modal-actions{display:flex;gap:8px;justify-content:flex-end}
.modal-actions button{padding:8px 20px;border:none;border-radius:var(--radius);font-size:0.8125rem;cursor:pointer;font-weight:500;font-family:var(--font)}
.modal-cancel{background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border)!important}
.modal-confirm{background:var(--danger);color:#fff}

/* Empty State */
.empty-state{padding:32px 16px;text-align:center;color:var(--text-secondary);font-size:0.8125rem}

/* Loading */
.loading-dots{display:inline-flex;align-items:center;gap:3px}
.loading-dots span{width:4px;height:4px;border-radius:50%;background:var(--text-secondary);animation:dotPulse 1.4s infinite;display:inline-block}
.loading-dots span:nth-child(2){animation-delay:0.2s}
.loading-dots span:nth-child(3){animation-delay:0.4s}
@keyframes dotPulse{0%,80%,100%{opacity:0.3;transform:scale(0.85)}40%{opacity:1;transform:scale(1)}}

/* Responsive */
@media(max-width:768px){.main-content{padding:16px}.page-header{flex-direction:column;align-items:flex-start}.account-form{flex-direction:column}.account-input{min-width:100%}}
</style>
</head>
<body>
<div class="dashboard-layout">
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1>Qwen Gate</h1>
      <div class="live-indicator"><span class="live-dot"></span>Live</div>
    </div>
    <nav class="sidebar-nav">
      <a href="/dashboard" class="nav-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        <span>Overview</span>
      </a>
      <a href="/dashboard/logs" class="nav-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        <span>Logs</span>
      </a>
      <a href="/dashboard/accounts" class="nav-link active">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>Accounts</span>
      </a>
      <a href="/dashboard/network" class="nav-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        <span>Network</span>
      </a>
      <a href="/dashboard/settings" class="nav-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Settings</span>
      </a>
    </nav>
    <div class="sidebar-footer" id="uptimeDisplay">—</div>
  </aside>
  <main class="main-content">
    <div class="page-header">
      <h1>Accounts</h1>
    </div>

    <!-- Error Display -->
    <div class="error-box" id="errorBox"></div>

    <!-- Add Account Form -->
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Add Account</span>
      </div>
      <div class="panel-body">
        <form class="account-form" id="addForm">
          <input type="email" class="account-input" id="emailInput" placeholder="Email" required autocomplete="email">
          <input type="password" class="account-input" id="passwordInput" placeholder="Password" required autocomplete="new-password">
          <button type="submit" class="account-btn" id="addBtn">Add Account</button>
        </form>
      </div>
    </div>

    <!-- Accounts Table -->
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Accounts</span>
        <span id="acctCount" style="font-size:0.7rem;color:var(--text-secondary);font-weight:500"></span>
      </div>
      <div class="panel-body">
        <div class="tbl-wrap">
          <table id="acctTable">
            <thead>
              <tr>
                <th>Email</th>
                <th>Auth Status</th>
                <th>In Flight</th>
                <th>Total Reqs</th>
                <th>Throttle</th>
                <th>Token TTL</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="acctBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="emptyState">No accounts configured. Add one above.</div>
      </div>
    </div>
  </main>
</div>

<!-- Confirmation Modal -->
<div class="modal-overlay" id="confirmOverlay">
  <div class="modal">
    <h3>Remove Account</h3>
    <p>Are you sure you want to remove <strong id="confirmEmail"></strong>? This cannot be undone.</p>
    <div class="modal-actions">
      <button class="modal-cancel" id="confirmNo">Cancel</button>
      <button class="modal-confirm" id="confirmYes">Remove</button>
    </div>
  </div>
</div>

<!-- Toast Container -->
<div class="toast-container" id="toastContainer"></div>

<script>
/* ── Helpers ── */
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}

function authHeaders() {
  return window.API_KEY ? { 'Authorization': 'Bearer ' + window.API_KEY } : {};
}

function fmtTTL(ms) {
  if (ms == null || ms < 0) return '\u2014';
  var m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  m %= 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, 3500);
}

function setError(msg) {
  var box = document.getElementById('errorBox');
  if (msg) {
    box.textContent = msg;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}

/* ── Fetch wrapper ── */
async function apiFetch(url) {
  try {
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}

/* ── Accounts Table ── */
function getAuthStatus(acct) {
  if (acct.authenticated) return 'live';
  if (acct.throttled) return 'throttled';
  if (acct.tokenExpiresInMs != null && acct.tokenExpiresInMs < 0) return 'expired';
  return 'unknown';
}

function getAuthLabel(status) {
  if (status === 'live') return 'Authenticated';
  if (status === 'expired') return 'Expired';
  if (status === 'throttled') return 'Throttled';
  return 'Not authenticated';
}

function makeThrottleBadge(acct) {
  if (acct.throttled) {
    var label = 'Throttled';
    if (acct.throttledRemainingMs != null) label += ' ' + fmtTTL(acct.throttledRemainingMs);
    return '<span class="badge badge-warning">' + label + '</span>';
  }
  return '<span class="badge badge-neutral">OK</span>';
}

function renderAccountsTable(accts) {
  if (!Array.isArray(accts) || accts.length === 0) {
    document.getElementById('acctBody').innerHTML = '';
    document.getElementById('emptyState').style.display = '';
    setText('acctCount', '');
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  setText('acctCount', accts.length + ' total');
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var status = getAuthStatus(a);
    var label = getAuthLabel(status);
    var hideLogin = status === 'live' ? ' style="display:none"' : '';
    rows += '<tr>'
      + '<td>' + escHtml(a.email) + '</td>'
      + '<td><div class="auth-status"><span class="auth-dot ' + status + '"></span>' + label + '</div></td>'
      + '<td>' + (a.inFlight || 0) + '</td>'
      + '<td>' + (a.totalRequests || 0) + '</td>'
      + '<td>' + makeThrottleBadge(a) + '</td>'
      + '<td style="font-family:var(--mono);font-size:0.75rem">' + fmtTTL(a.tokenExpiresInMs) + '</td>'
      + '<td><div class="action-cell">'
      + '<button class="account-btn small danger" data-email="' + escHtml(a.email) + '" data-action="remove">Remove</button>'
      + '<button class="account-btn small primary" data-email="' + escHtml(a.email) + '" data-action="login"' + hideLogin + '>Login</button>'
      + '</div></td></tr>';
  }
  document.getElementById('acctBody').innerHTML = rows;
}

/* ── Load Accounts ── */
async function loadAccounts() {
  var data = await apiFetch('/accounts');
  renderAccountsTable(data);
}

/* ── Add Account ── */
function handleAdd(email, password) {
  var btn = document.getElementById('addBtn');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  setError(null);
  (async function() {
    try {
      var res = await fetch('/api/accounts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ email: email, password: password })
      });
      var result;
      try { result = await res.json(); } catch(e) { result = null; }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Failed to add account (' + res.status + ')');
      }
      if (result.loginSucceeded) {
        showToast('Account added and logged in: ' + email, 'success');
        pollAuth(email, 15);
      } else {
        showToast((result.loginError || 'Account added but login failed. Click Login to open browser.'), 'warning');
        pollAuth(email, 15);
      }
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add Account';
    }
  })();
}

/* ── Remove Account ── */
function handleRemove(email) {
  document.getElementById('confirmEmail').textContent = email;
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmYes').onclick = async function() {
    document.getElementById('confirmOverlay').classList.remove('open');
    setError(null);
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
        method: 'DELETE',
        headers: authHeaders()
      });
      var result;
      try { result = await res.json(); } catch(e) { result = null; }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Failed to remove account (' + res.status + ')');
      }
      showToast('Account removed: ' + email, 'success');
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    }
  };
  document.getElementById('confirmNo').onclick = function() {
    document.getElementById('confirmOverlay').classList.remove('open');
  };
}

/* ── Manual Login ── */
function handleManualLogin(email) {
  var btn = document.querySelector('button[data-email="' + escHtml(email) + '"][data-action="login"]');
  if (btn) { btn.textContent = 'Opening...'; btn.disabled = true; }
  setError(null);
  (async function() {
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email) + '/autofill', {
        method: 'GET',
        headers: authHeaders()
      });
      var result;
      try { result = await res.json(); } catch(e) { result = null; }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Login failed (' + res.status + ')');
      }
      if (btn) { btn.textContent = 'Browser open'; setTimeout(function() { btn.textContent = 'Login'; btn.disabled = false; }, 5000); }
      showToast('Browser opened \u2014 log in manually. Session will be captured.', 'warning');
      pollAuth(email, 30);
    } catch (e) {
      if (btn) { btn.textContent = 'Login'; btn.disabled = false; }
      setError(e.message);
      showToast(e.message, 'error');
    }
  })();
}

/* ── Poll Auth ── */
function pollAuth(email, maxAttempts) {
  var attempt = 0;
  var timer = setInterval(async function() {
    attempt++;
    try {
      var data = await apiFetch('/accounts');
      if (!Array.isArray(data)) { clearInterval(timer); return; }
      for (var i = 0; i < data.length; i++) {
        if (data[i].email === email && data[i].authenticated) {
          clearInterval(timer);
          showToast('Login completed for ' + email, 'success');
          loadAccounts();
          return;
        }
      }
    } catch(e) { clearInterval(timer); }
    if (attempt >= maxAttempts) { clearInterval(timer); loadAccounts(); }
  }, 2000);
}

/* ── Init ── */
function init() {
  /* Load on start */
  loadAccounts();

  /* Auto-poll every 2 seconds */
  setInterval(loadAccounts, 2000);

  /* Add form submit */
  document.getElementById('addForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var email = document.getElementById('emailInput').value.trim();
    var password = document.getElementById('passwordInput').value;
    if (!email || !password) {
      showToast('Email and password are required', 'error');
      return;
    }
    handleAdd(email, password);
    this.reset();
  });

  /* Table button delegation */
  document.getElementById('acctTable').addEventListener('click', function(e) {
    var btn = e.target;
    if (btn.tagName !== 'BUTTON') return;
    var email = btn.getAttribute('data-email');
    var action = btn.getAttribute('data-action');
    if (!email || !action) return;
    if (action === 'login') handleManualLogin(email);
    else if (action === 'remove') handleRemove(email);
  });

  /* Close modal on overlay click */
  document.getElementById('confirmOverlay').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
</script>
</body>
</html>`;