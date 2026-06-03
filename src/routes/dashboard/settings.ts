export const settingsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — Settings</title>
<script></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Montserrat:wght@400;500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap');
:root{--bg-primary:#F5F1EA;--bg-card:#E9E2D6;--bg-elevated:#DDD4C6;--border:#C9BFAE;--text-primary:#1a1615;--text-secondary:#8a7f6f;--text-display:#4a4540;--accent:#5E9D5C;--accent-soft:rgba(94,157,92,0.2);--success:#3D8B3D;--success-soft:rgba(61,139,61,0.15);--warning:#C8983A;--warning-soft:rgba(200,152,58,0.15);--danger:#C96B6B;--danger-soft:rgba(201,107,107,0.15);--radius:16px;--radius-sm:10px;--sidebar-width:220px;--font:'Montserrat',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--display:'Poppins',sans-serif;--mono:'JetBrains Mono','SF Mono',Monaco,Consolas,monospace;--clay-shadow:6px 6px 12px rgba(0,0,0,0.06),-2px -2px 6px rgba(255,255,255,0.5);--clay-shadow-sm:3px 3px 6px rgba(0,0,0,0.04),-1px -1px 3px rgba(255,255,255,0.4);--clay-puff:inset 2px 2px 4px rgba(255,255,255,0.6),inset -2px -2px 4px rgba(0,0,0,0.04)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--font);background:var(--bg-primary);color:var(--text-primary);line-height:1.5;min-height:100vh}

/* Sidebar Live Indicator */
.live-indicator{display:flex;align-items:center;gap:6px;font-size:0.7rem;color:var(--success);text-transform:uppercase;letter-spacing:0.05em;font-weight:500}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;display:inline-block}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.85)}}

/* Bold/Display text */
.sidebar-header h1{color:var(--text-display)}

/* Dashboard Layout */
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
.main-content{flex:1;margin-left:var(--sidebar-width);padding:24px;width:calc(100% - var(--sidebar-width))}

/* Header */
.settings-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.settings-header h1{font-size:1.25rem;font-weight:700;font-family:var(--display);color:var(--text-primary);letter-spacing:-0.01em}
.save-btn{padding:10px 28px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);font-size:0.875rem;font-weight:500;cursor:pointer;font-family:var(--font);transition:opacity 0.2s;box-shadow:var(--clay-shadow-sm)}
.save-btn:hover{opacity:0.9}
.save-btn:disabled{opacity:0.5;cursor:not-allowed}

/* Sections */
.settings-sections{display:flex;flex-direction:column;gap:12px}
.settings-section{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px 20px;margin:0;box-shadow:var(--clay-shadow)}
.settings-section-title{font-size:0.95rem;font-weight:600;color:var(--text-primary);margin:0 0 4px}
.settings-section-desc{font-size:0.75rem;color:var(--text-secondary);margin:0 0 14px;line-height:1.45}
.settings-fields{display:grid;grid-template-columns:repeat(2,1fr);gap:10px 16px}

/* Field */
.settings-field{display:flex;flex-direction:column;gap:3px}
.settings-field label{font-size:0.68rem;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em}
.settings-field input[type="text"],.settings-field input[type="number"],.settings-field input[type="password"]{padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-elevated);font-size:0.8rem;color:var(--text-primary);transition:border-color 0.15s;font-family:var(--mono);box-shadow:var(--clay-puff)}
.settings-field input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.settings-field input[type="number"]{-moz-appearance:textfield}
.settings-field input[type="number"]::-webkit-inner-spin-button,.settings-field input[type="number"]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.settings-field select{padding:7px 28px 7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-elevated);font-size:0.8rem;color:var(--text-primary);cursor:pointer;transition:border-color 0.15s;font-family:var(--font);appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;box-shadow:var(--clay-puff)}
.settings-field select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}

/* Checkbox */
.settings-checkbox{display:flex;align-items:center;gap:8px;font-size:0.8125rem;color:var(--text-primary);cursor:pointer;padding:4px 0;user-select:none}
.settings-checkbox input[type="checkbox"]{width:16px;height:16px;border-radius:4px;accent-color:var(--accent);cursor:pointer;flex-shrink:0}

/* Message */
.settings-message{padding:10px 14px;border-radius:var(--radius-sm);font-size:0.8rem;font-weight:500;margin:12px 0}
.settings-message.success{background:var(--success-soft);color:var(--success)}
.settings-message.error{background:var(--danger-soft);color:var(--danger)}

/* Toast */
.toast-container{position:fixed;bottom:20px;right:20px;z-index:1000;display:flex;flex-direction:column;gap:8px}
.toast{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;box-shadow:var(--clay-shadow);animation:slideIn 0.3s ease;font-size:0.8125rem;max-width:380px}
.toast.success{border-left:3px solid var(--success)}
.toast.error{border-left:3px solid var(--danger)}
.toast.warning{border-left:3px solid var(--warning)}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}

@media(max-width:768px){.settings-fields{grid-template-columns:1fr}.settings-header{flex-direction:column;align-items:flex-start;gap:12px}}
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
      <a href="/dashboard/accounts" class="nav-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>Accounts</span>
      </a>
      <a href="/dashboard/network" class="nav-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        <span>Network</span>
      </a>
      <a href="/dashboard/settings" class="nav-link active">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Settings</span>
      </a>
    </nav>
    <div class="sidebar-footer" id="uptimeDisplay">—</div>
  </aside>
  <main class="main-content">

<div class="settings-header">
  <h1>Settings</h1>
  <button class="save-btn" id="settingsSaveBtn" onclick="saveSettings()">Save Changes</button>
</div>

<div class="settings-sections" id="settingsSections"></div>
<div id="settingsMessage"></div>

<div class="toast-container" id="toastContainer"></div>

  </main>
</div>

<script>
var API_KEY = window.API_KEY || '';

/* ── Helpers ── */
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, 3500);
}

var settingsData = {};

var SETTINGS_SECTIONS = [
  { title: 'Server', desc: 'Network binding, browser engine, and dashboard settings.', fields: [
    { key: 'PORT', label: 'PORT', type: 'number' },
    { key: 'HOST', label: 'HOST', type: 'text' },
    { key: 'API_KEY', label: 'API_KEY', type: 'password' },
    { key: 'BROWSER', label: 'BROWSER', type: 'select', options: [
      { value: 'chromium', label: 'Chromium' },
      { value: 'firefox', label: 'Firefox' },
      { value: 'chrome', label: 'Chrome' },
      { value: 'edge', label: 'Edge' }
    ]},
    { key: 'BROWSER_HEADLESS', label: 'BROWSER_HEADLESS', type: 'checkbox' }
  ]},
  { title: 'Pipeline', desc: 'Output transformation, streaming, and tool-call behaviour.', fields: [
    { key: 'TOOL_CALLING', label: 'TOOL_CALLING', type: 'checkbox' },
    { key: 'CLEAN_OUTPUT', label: 'CLEAN_OUTPUT', type: 'checkbox' },
    { key: 'CONTENT_FILTER', label: 'CONTENT_FILTER', type: 'checkbox' },
    { key: 'STREAMING', label: 'STREAMING', type: 'select', options: [
      { value: '', label: 'Default (respect client)' },
      { value: 'true', label: 'Always stream' },
      { value: 'false', label: 'Never stream' }
    ]},
    { key: 'NON_STREAMING', label: 'NON_STREAMING', type: 'select', options: [
      { value: '', label: 'Default (respect client)' },
      { value: 'true', label: 'Always non-streaming' }
    ]},
    { key: 'MAX_TOOL_CALLS_PER_RESPONSE', label: 'MAX_TOOL_CALLS_PER_RESPONSE', type: 'number' }
  ]},
  { title: 'Echo Detection', desc: 'Detects when the model parrots tool results and triggers a retry.', fields: [
    { key: 'ECHO_DETECTOR', label: 'ECHO_DETECTOR', type: 'checkbox' },
    { key: 'ECHO_JACCARD_THRESHOLD', label: 'ECHO_JACCARD_THRESHOLD', type: 'number', step: '0.1' },
    { key: 'ECHO_MIN_LINE_LENGTH', label: 'ECHO_MIN_LINE_LENGTH', type: 'number' },
    { key: 'ECHO_MIN_UNIQUE_SHINGLES', label: 'ECHO_MIN_UNIQUE_SHINGLES', type: 'number' }
  ]},
  { title: 'Auth', desc: 'Qwen fetch timeout, token expiry, session cleanup, and rate limiting.', fields: [
    { key: 'QWEN_FETCH_TIMEOUT_MS', label: 'QWEN_FETCH_TIMEOUT_MS', type: 'number' },
    { key: 'AUTH_TOKEN_MAX_AGE_MS', label: 'AUTH_TOKEN_MAX_AGE_MS', type: 'number' },
    { key: 'AUTH_REFRESH_BEFORE_MS', label: 'AUTH_REFRESH_BEFORE_MS', type: 'number' },
    { key: 'DELETE_SESSION', label: 'DELETE_SESSION', type: 'checkbox' },
    { key: 'RATE_LIMIT_COOLDOWN_MS', label: 'RATE_LIMIT_COOLDOWN_MS', type: 'number' }
  ]},
  { title: 'Logging', desc: 'Log levels, format, and retention.', fields: [
    { key: 'DEBUG', label: 'DEBUG', type: 'checkbox' },
    { key: 'DEBUG_STREAM', label: 'DEBUG_STREAM', type: 'checkbox' },
    { key: 'LOG_LEVEL', label: 'LOG_LEVEL', type: 'select', options: [
      { value: 'debug', label: 'debug' },
      { value: 'info', label: 'info' },
      { value: 'warn', label: 'warn' },
      { value: 'error', label: 'error' }
    ]},
    { key: 'LOG_FORMAT', label: 'LOG_FORMAT', type: 'select', options: [
      { value: 'text', label: 'text' },
      { value: 'json', label: 'json' }
    ]},
    { key: 'LOG_MAX_ENTRIES', label: 'LOG_MAX_ENTRIES', type: 'number' }
  ]},
  { title: 'Retry', desc: 'Upstream retry with exponential backoff and jitter.', fields: [
    { key: 'RETRY_ENABLED', label: 'RETRY_ENABLED', type: 'checkbox' },
    { key: 'RETRY_MAX_ATTEMPTS', label: 'RETRY_MAX_ATTEMPTS', type: 'number' },
    { key: 'RETRY_BASE_DELAY_MS', label: 'RETRY_BASE_DELAY_MS', type: 'number' },
    { key: 'RETRY_MAX_DELAY_MS', label: 'RETRY_MAX_DELAY_MS', type: 'number' },
    { key: 'RETRY_BACKOFF_MULTIPLIER', label: 'RETRY_BACKOFF_MULTIPLIER', type: 'number', step: '0.1' }
  ]}
];

/* ── Render ── */
function renderSettingsForm() {
  var container = document.getElementById('settingsSections');
  var html = '';
  for (var s = 0; s < SETTINGS_SECTIONS.length; s++) {
    var section = SETTINGS_SECTIONS[s];
    html += '<fieldset class="settings-section">'
      + '<div class="settings-section-title">' + escHtml(section.title) + '</div>'
      + '<p class="settings-section-desc">' + escHtml(section.desc) + '</p>'
      + '<div class="settings-fields">';
    for (var f = 0; f < section.fields.length; f++) {
      var field = section.fields[f];
      var val = settingsData[field.key] !== undefined ? settingsData[field.key] : '';
      html += renderSettingsField(field, val);
    }
    html += '</div></fieldset>';
  }
  container.innerHTML = html;
}

function renderSettingsField(field, val) {
  if (field.type === 'checkbox') {
    var checked = val === 'true' ? ' checked' : '';
    return '<label class="settings-checkbox">'
      + '<input type="checkbox" data-key="' + field.key + '"' + checked + ' onchange="onCheckboxChange(this)">'
      + '<span>' + escHtml(field.label) + '</span></label>';
  }
  if (field.type === 'select') {
    var opts = '';
    for (var o = 0; o < field.options.length; o++) {
      var opt = field.options[o];
      var sel = opt.value === val ? ' selected' : '';
      opts += '<option value="' + escHtml(opt.value) + '"' + sel + '>' + escHtml(opt.label) + '</option>';
    }
    return '<div class="settings-field">'
      + '<label for="cfg-' + field.key + '">' + escHtml(field.label) + '</label>'
      + '<select id="cfg-' + field.key + '" data-key="' + field.key + '" onchange="onFieldChange(this)">' + opts + '</select></div>';
  }
  var inputType = field.type || 'text';
  var stepAttr = field.step ? ' step="' + field.step + '"' : '';
  return '<div class="settings-field">'
    + '<label for="cfg-' + field.key + '">' + escHtml(field.label) + '</label>'
    + '<input type="' + inputType + '" id="cfg-' + field.key + '" data-key="' + field.key + '" value="' + escHtml(val) + '"' + stepAttr + ' oninput="onFieldChange(this)"></div>';
}

/* ── Change tracking ── */
function onFieldChange(el) {
  settingsData[el.getAttribute('data-key')] = el.value;
}
function onCheckboxChange(el) {
  var key = el.getAttribute('data-key');
  settingsData[key] = el.checked ? 'true' : '';
}

/* ── Load ── */
async function loadSettings() {
  try {
    var headers = {};
    if (API_KEY) headers['Authorization'] = 'Bearer ' + API_KEY;
    var res = await fetch('/api/config', { headers: headers });
    if (!res.ok) return;
    var data = await res.json();
    if (data && data.config) {
      settingsData = {};
      var keys = Object.keys(data.config);
      for (var i = 0; i < keys.length; i++) {
        settingsData[keys[i]] = data.config[keys[i]];
      }
    }
    renderSettingsForm();
  } catch(e) {
    /* silent */
  }
}

/* ── Save ── */
async function saveSettings() {
  var btn = document.getElementById('settingsSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  var msgEl = document.getElementById('settingsMessage');
  try {
    var headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['Authorization'] = 'Bearer ' + API_KEY;
    var res = await fetch('/api/config', {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(settingsData)
    });
    var result = await res.json();
    if (!res.ok) {
      msgEl.innerHTML = '<div class="settings-message error">' + escHtml(result.error || 'Save failed (' + res.status + ')') + '</div>';
    } else {
      if (result.config) {
        var keys = Object.keys(result.config);
        for (var i = 0; i < keys.length; i++) {
          settingsData[keys[i]] = result.config[keys[i]];
        }
        renderSettingsForm();
      }
      msgEl.innerHTML = '<div class="settings-message success">Settings saved successfully.</div>';
      setTimeout(function() { msgEl.innerHTML = ''; }, 4000);
    }
  } catch(e) {
    msgEl.innerHTML = '<div class="settings-message error">' + escHtml(e.message) + '</div>';
  }
  btn.disabled = false;
  btn.textContent = 'Save Changes';
}

/* ── Init ── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadSettings);
} else {
  loadSettings();
}
</script>
</body>
</html>`;