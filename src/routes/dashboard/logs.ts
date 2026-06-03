export const logsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — Request Log</title>
<script></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Montserrat:wght@400;500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap');
:root{--bg-primary:#F5F1EA;--bg-card:#E9E2D6;--bg-elevated:#DDD4C6;--border:#C9BFAE;--text-primary:#1a1615;--text-secondary:#8a7f6f;--text-display:#4a4540;--accent:#5E9D5C;--accent-soft:rgba(94,157,92,0.2);--success:#3D8B3D;--success-soft:rgba(61,139,61,0.15);--warning:#C8983A;--warning-soft:rgba(200,152,58,0.15);--danger:#C96B6B;--danger-soft:rgba(201,107,107,0.15);--radius:16px;--radius-sm:10px;--sidebar-width:220px;--font:'Montserrat',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--display:'Poppins',sans-serif;--mono:'JetBrains Mono','SF Mono',Monaco,Consolas,monospace;--clay-shadow:6px 6px 12px rgba(0,0,0,0.06),-2px -2px 6px rgba(255,255,255,0.5);--clay-shadow-sm:3px 3px 6px rgba(0,0,0,0.04),-1px -1px 3px rgba(255,255,255,0.4);--clay-puff:inset 2px 2px 4px rgba(255,255,255,0.6),inset -2px -2px 4px rgba(0,0,0,0.04)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--font);background:var(--bg-primary);color:var(--text-primary);line-height:1.5;min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}

/* Dashboard Layout */
.dashboard-layout{display:flex;min-height:100vh}

/* Sidebar */
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

/* Live Indicator */
.live-indicator{display:flex;align-items:center;gap:6px;font-size:0.7rem;color:var(--success);text-transform:uppercase;letter-spacing:0.05em;font-weight:500}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;display:inline-block}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.85)}}

/* Bold/Display text */
.page-header h1, .sidebar-header h1{color:var(--text-display)}

/* Page Header */
.page-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.page-header h1{font-size:1.35rem;font-family:var(--display);font-weight:700;letter-spacing:-0.02em;display:flex;align-items:center;gap:10px}
.page-header-left{display:flex;align-items:center;gap:10px}
.page-header-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* Badges */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:500;white-space:nowrap;gap:4px;line-height:1.4;box-shadow:var(--clay-shadow-sm)}
.badge-success{background:var(--success-soft);color:var(--success)}
.badge-danger{background:var(--danger-soft);color:var(--danger)}
.badge-warning{background:var(--warning-soft);color:var(--warning)}
.badge-accent{background:var(--accent-soft);color:var(--accent)}
.badge-neutral{background:var(--bg-elevated);color:var(--text-secondary)}

/* Action Buttons */
.action-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);font-size:0.75rem;font-weight:500;cursor:pointer;transition:all 0.15s;font-family:var(--font);white-space:nowrap;box-shadow:var(--clay-shadow)}
.action-btn:hover{color:var(--text-primary);border-color:var(--accent);background:var(--bg-elevated)}
.action-btn.danger:hover{border-color:var(--danger);color:var(--danger)}
.action-btn:disabled{opacity:0.5;cursor:not-allowed;pointer-events:none}

/* Request Log Container */
#requestLogContainer{min-height:200px}
#requestLogEmpty{padding:40px 16px;text-align:center;color:var(--text-secondary);font-size:0.875rem;display:block}

/* Request Entry */
.req-entry{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px;animation:fadeIn 0.3s ease;box-shadow:var(--clay-shadow),var(--clay-puff)}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.req-header{display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap}
.req-ts{font-family:var(--mono);font-size:0.7rem;color:var(--text-secondary);flex-shrink:0}
.req-detail{padding:4px 0 0 0}
.req-section-label{font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin:8px 0 4px;font-weight:500}
.req-block{background:var(--bg-elevated);border-radius:var(--radius-sm);padding:10px 12px;font-family:var(--mono);font-size:0.7rem;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:var(--text-primary);max-height:300px;overflow:auto}
.req-block pre{margin:0;white-space:pre-wrap;word-break:break-all;font-family:var(--mono);font-size:0.7rem;line-height:1.6;color:var(--text-primary)}

/* Foldable Sections */
.foldable-section{border:1px solid var(--border);border-radius:var(--radius-sm);margin:6px 0;overflow:hidden;box-shadow:var(--clay-shadow)}
.foldable-header{cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;padding:6px 8px;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500;background:var(--bg-elevated)}
.foldable-header:hover{color:var(--text-primary)}
.fold-toggle{display:inline-block;transition:transform .2s;font-size:9px}
.foldable-header.collapsed .fold-toggle{transform:rotate(0deg)}
.foldable-header:not(.collapsed) .fold-toggle{transform:rotate(90deg)}
.foldable-body.collapsed{display:none}
.foldable-body:not(.collapsed){padding:4px 8px}

/* Log Entry Grid Layout */
.req-error-top{margin-bottom:8px;padding:8px 12px;background:var(--danger-soft);border-radius:var(--radius-sm)}
.req-detail-grid{display:grid;grid-template-columns:70fr 30fr;gap:10px}
.req-left-col,.req-right-col{display:flex;flex-direction:column;gap:6px}
.req-right-col{height:100%}
.req-right-col>.foldable-section{flex:1;display:flex;flex-direction:column;min-height:0}
.req-right-col>.foldable-section>.foldable-body{flex:1;overflow-y:auto;max-height:none!important}
.req-output-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media(max-width:768px){.req-detail-grid{grid-template-columns:1fr}}
@media(max-width:600px){.req-output-grid{grid-template-columns:1fr}}

.msg-header{cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:4px;padding:2px 0}
.msg-header .fold-toggle{display:inline-block;transition:transform .2s;font-size:7px;margin-right:2px}
.msg-header.collapsed .fold-toggle{transform:rotate(0deg)}
.msg-header:not(.collapsed) .fold-toggle{transform:rotate(90deg)}
.msg-body.collapsed{display:none}
.msg-body:not(.collapsed){max-height:250px;overflow-y:auto}

/* Load More Button */
.load-more-btn{display:block;width:100%;padding:10px;margin:8px 0;background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent);border-radius:var(--radius-sm);cursor:pointer;font-size:0.8125rem;font-weight:500;text-align:center;transition:all 0.2s;font-family:var(--font)}
.load-more-btn:hover{background:var(--accent);color:var(--text-primary)}
.load-more-btn:disabled{opacity:0.5;cursor:not-allowed}

/* Connection Status */
.conn-status{font-size:0.65rem;font-weight:500;display:flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9999px;transition:all 0.3s}
.conn-status.connected{background:var(--success-soft);color:var(--success)}
.conn-status.disconnected{background:var(--danger-soft);color:var(--danger)}
.conn-status.connecting{background:var(--warning-soft);color:var(--warning)}

/* Count Badge */
.count-badge{font-size:0.65rem;color:var(--text-secondary);background:var(--bg-elevated);padding:2px 8px;border-radius:9999px;font-family:var(--mono)}

/* Entry Count */
#entryCount{font-size:0.75rem;color:var(--text-secondary);font-family:var(--mono)}

/* Loading skeleton */
.skeleton{background:linear-gradient(90deg,var(--bg-elevated) 25%,var(--bg-card) 50%,var(--bg-elevated) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:var(--radius);height:60px;margin-bottom:8px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* Responsive */
@media(max-width:768px){.dashboard-layout{flex-direction:column}.sidebar{position:relative;width:100%;min-width:0;height:auto;border-right:none;border-bottom:1px solid var(--border);flex-direction:row;align-items:center;padding:0 8px}.sidebar-header{border-bottom:none;padding:8px;flex-shrink:0}.sidebar-nav{flex-direction:row;padding:4px;overflow-x:auto;flex:1}.sidebar-footer{display:none}.main-content{margin-left:0;padding:16px}.nav-link{width:auto;white-space:nowrap;font-size:0.75rem;padding:6px 12px;justify-content:center}}
@media(max-width:600px){.page-header{flex-direction:column;align-items:flex-start}.page-header-right{width:100%;justify-content:flex-start}.req-header{gap:4px}.badge{font-size:0.65rem;padding:1px 6px}.req-entry{padding:8px}.main-content{padding:12px}.nav-link{padding:6px 10px;font-size:0.7rem}}
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
      <a href="/dashboard/logs" class="nav-link active">
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
      <a href="/dashboard/settings" class="nav-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Settings</span>
      </a>
    </nav>
    <div class="sidebar-footer" id="uptimeDisplay">—</div>
  </aside>
  <main class="main-content">
    <!-- Header -->
    <div class="page-header">
      <div class="page-header-left">
        <h1>
          Request Log
          <span class="live-indicator" id="liveIndicator" style="display:none"><span class="live-dot"></span>Live</span>
        </h1>
      </div>
      <div class="page-header-right">
        <span id="entryCount">0 entries</span>
        <span class="conn-status connected" id="connStatus">Connected</span>
        <button class="action-btn" id="clearBtn" onclick="clearLog()" title="Clear all log entries">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          Clear
        </button>
      </div>
    </div>

    <!-- Request Log Entries Container -->
    <div id="requestLogContainer">
      <div class="skeleton" id="loadingSkeleton"></div>
      <div class="skeleton" id="loadingSkeleton2"></div>
      <div class="empty-state" id="requestLogEmpty">Waiting for requests&hellip;</div>
    </div>

    <!-- Load More Button (hidden by default) -->
    <button class="load-more-btn" id="loadMoreBtn" onclick="loadMore()" style="display:none">
      Load More (<span id="hiddenCount">0</span> hidden)
    </button>
  </main>
</div>

<script>
/* ── State ── */
var MAX_VISIBLE_ENTRIES = 10;
var logEntries = [];
var logEntryMap = {};
var hiddenEntries = [];

/* ── Helpers ── */
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtTime(ts) {
  if (!ts) return '—';
  var d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + ' ' + ampm;
}
function fmtJson(raw) {
  if (!raw) return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch(e) { return raw; }
}
function fmtTokens(tokens) {
  if (!tokens) return '';
  var total = (tokens.prompt || 0) + (tokens.completion || 0);
  if (!total) return '';
  return total + ' tok';
}

/* ── Fetch wrapper ── */
function apiFetch(url) {
  return fetch(url, {
    headers: window.API_KEY ? { 'Authorization': 'Bearer ' + window.API_KEY } : {}
  }).then(function(r) {
    if (!r.ok) return null;
    return r.json();
  }).catch(function() { return null; });
}

/* ── Connection status ── */
function setConnStatus(state) {
  var el = document.getElementById('connStatus');
  if (!el) return;
  el.className = 'conn-status';
  if (state === 'connected') {
    el.classList.add('connected');
    el.textContent = 'Connected';
  } else if (state === 'connecting') {
    el.classList.add('connecting');
    el.textContent = 'Reconnecting...';
  } else {
    el.classList.add('disconnected');
    el.textContent = 'Disconnected';
  }
}

/* ── SSE Connection ── */
function connectSSE() {
  setConnStatus('connecting');
  setTimeout(function() {
    var url = '/log/stream';
    if (window.API_KEY) url += (url.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(window.API_KEY);
    var es = new EventSource(url);
    es.onmessage = function(ev) {
      try {
        var entry = JSON.parse(ev.data);
        addRequestEntry(entry);
        setConnStatus('connected');
      } catch(e) { /* ignore parse errors */ }
    };
    es.onerror = function() {
      es.close();
      setConnStatus('disconnected');
      setTimeout(connectSSE, 3000);
    };
    es.onopen = function() {
      setConnStatus('connected');
    };
  }, 300);
}

/* ── Render a single entry ── */
function renderEntryHtml(entry) {
  var model = entry.model || 'unknown';
  var stream = entry.stream !== false;
  var hasError = entry.errors && entry.errors.length > 0;
  var isDone = entry.finalResponse && entry.finalResponse.finishReason === 'stop';
  var status = hasError ? 'error' : (isDone ? 'done' : 'streaming');
  var statusBadge = status === 'error' ? 'badge-danger' : status === 'done' ? 'badge-success' : 'badge-accent';
  var rawText = entry.rawFullContent || '';
  var processedText = entry.processedApiOutput || '';

  /* ── Header row ── */
  var html = '<div class="req-header">'
    + '<span class="req-ts">' + fmtTime(entry.timestamp || Date.now()) + '</span>'
    + '<span class="badge badge-neutral">' + escHtml(model) + '</span>'
    + '<span class="badge ' + (stream ? 'badge-accent' : 'badge-neutral') + '">' + (stream ? 'SSE' : 'SYNC') + '</span>'
    + '<span class="badge ' + statusBadge + '">' + status + '</span>'
    + (entry.tokens ? '<span style="font-family:var(--mono);font-size:0.7rem;color:var(--text-secondary)">' + fmtTokens(entry.tokens) + '</span>' : '')
    + (entry.accountEmail ? '<span class="badge badge-neutral" style="background:var(--accent-soft);color:var(--accent);border:1px solid rgba(224,139,110,0.3)">' + escHtml(entry.accountEmail.split('@')[0]) + '</span>' : '')
    + '</div>';

  /* ── Error section (full width, top) ── */
  if (hasError) {
    html += '<div class="req-error-top">';
    for (var ei = 0; ei < entry.errors.length; ei++) {
      var e = entry.errors[ei];
      var isWarn = e.indexOf('ECHO') !== -1 || e.indexOf('LOOP') !== -1 || e.indexOf('Loop') !== -1 || e.indexOf('parallel') !== -1;
      var badgeClass = isWarn ? 'badge-warning' : 'badge-danger';
      var label = isWarn ? 'WARN' : 'ERROR';
      html += '<div style="margin:4px 0;padding:6px 8px;background:var(--bg-elevated);border-radius:var(--radius-sm);font-family:var(--mono);font-size:0.75rem"><span class="badge ' + badgeClass + '" style="margin-right:6px">' + label + '</span>' + escHtml(e) + '</div>';
    }
    html += '</div>';
  }

  /* ── Two-column grid ── */
  html += '<div class="req-detail"><div class="req-detail-grid">';

  /* ── Left column ── */
  html += '<div class="req-left-col">';

  /* Input — folded by default */
  if (entry.clientRequest && entry.clientRequest.messages && entry.clientRequest.messages.length > 0) {
    html += '<div class="foldable-section"><div class="foldable-header collapsed" onclick="toggleFold(this)"><span class="fold-toggle">▶</span> Input (' + entry.clientRequest.messages.length + ' msgs)</div><div class="foldable-body collapsed">';
    for (var mi = 0; mi < entry.clientRequest.messages.length; mi++) {
      var m = entry.clientRequest.messages[mi];
      var rc = m.role === 'system' ? 'badge-accent' : m.role === 'user' ? 'badge-neutral' : m.role === 'tool' ? 'badge-warning' : 'badge-success';
      html += '<div style="margin:8px 0"><div class="msg-header collapsed" onclick="toggleFold(this)"><span class="fold-toggle">▶</span><span class="badge ' + rc + '">' + escHtml(m.role) + '</span></div><div class="msg-body collapsed"><div class="req-block" style="margin-top:4px"><pre>' + escHtml(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) + '</pre></div></div></div>';
    }
    html += '</div></div>';
  }

  /* Raw Output + Processed Output — side by side */
  if (rawText || processedText) {
    html += '<div class="req-output-grid">';
    if (rawText) {
      html += '<div class="foldable-section"><div class="foldable-header" onclick="toggleFold(this)"><span class="fold-toggle">▶</span> Raw Output</div><div class="foldable-body"><pre style="margin:0;white-space:pre-wrap;word-break:break-all;overflow-x:auto;font-family:var(--mono);font-size:0.7rem;line-height:1.6;color:var(--text-primary)">' + escHtml(rawText) + '</pre></div></div>';
    }
    if (processedText) {
      html += '<div class="foldable-section"><div class="foldable-header" onclick="toggleFold(this)"><span class="fold-toggle">▶</span> Processed Output</div><div class="foldable-body"><pre style="margin:0;white-space:pre-wrap;word-break:break-all;overflow-x:auto;font-family:var(--mono);font-size:0.7rem;line-height:1.6;color:var(--text-primary)">' + escHtml(processedText) + '</pre></div></div>';
    }
    html += '</div>';
  }

  /* Tool Calls — unfolded by default */
  if (entry.parsedToolCalls && entry.parsedToolCalls.length > 0) {
    html += '<div class="req-section-label">Tool Calls</div>';
    for (var ti = 0; ti < entry.parsedToolCalls.length; ti++) {
      var tc = entry.parsedToolCalls[ti];
      var s = tc.blocked ? '<span class="badge badge-warning">BLOCKED</span>' : (tc.error ? '<span class="badge badge-danger">ERROR</span>' : '<span class="badge badge-success">SUCCESS</span>');
      var d = '';
      if (tc.blocked) d += 'Reason: ' + escHtml(tc.blockReason || 'N/A') + '<br>';
      if (tc.error) d += 'Error: ' + escHtml(tc.error) + '<br>';
      if (tc.result !== undefined) d += 'Result: ' + escHtml(typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)) + '<br>';
      if (tc.executionTimeMs !== undefined) d += 'Exec time: ' + tc.executionTimeMs + 'ms';
      var prettyArgs = '';
      if (tc.args) { try { prettyArgs = JSON.stringify(JSON.parse(tc.args), null, 2); } catch(e) { prettyArgs = tc.args; } }
      html += '<div style="margin:8px 0;padding:8px;background:var(--bg-elevated);border-radius:var(--radius-sm)">'
        + '<strong>' + escHtml(tc.name) + '</strong> ' + s + '<br>'
        + (tc.args ? '<div style="margin-top:4px;font-family:var(--mono);font-size:0.8em;white-space:pre-wrap">' + escHtml(prettyArgs) + '</div>' : '')
        + (d ? '<div style="margin-top:4px;font-family:var(--mono);font-size:0.8em;white-space:pre-wrap">' + d + '</div>' : '')
        + '</div>';
    }
  }

  html += '</div>'; /* end left-col */

  /* ── Right column ── */
  html += '<div class="req-right-col">';

  /* Chunk Stream — unfolded by default */
  if (entry.qwenRawChunks && entry.qwenRawChunks.length > 1) {
    html += '<div class="foldable-section"><div class="foldable-header" onclick="toggleFold(this)"><span class="fold-toggle">▶</span> Chunk Stream (' + entry.qwenRawChunks.length + ')</div><div class="foldable-body" style="max-height:70vh;overflow-y:auto">';
    for (var ci = 0; ci < entry.qwenRawChunks.length; ci++) {
      var c = entry.qwenRawChunks[ci];
      var isJson = typeof c === 'string' && c.trim().startsWith('{') && c.indexOf('"name"') > -1;
      html += '<div style="margin:4px 0;padding:4px 6px;border-left:3px solid ' + (isJson ? 'var(--accent)' : 'var(--text-secondary)') + ';font-family:var(--mono);font-size:0.7rem"><span class="badge ' + (isJson ? 'badge-accent' : 'badge-neutral') + '" style="margin-right:4px">#' + (ci + 1) + ' ' + (isJson ? 'tool' : 'text') + '</span>' + escHtml(c) + '</div>';
    }
    html += '</div></div>';
  }

  html += '</div>'; /* end right-col */
  html += '</div></div>'; /* end req-detail-grid + req-detail */

  return html;
}

/* ── Add entry to DOM ── */
function addRequestEntry(entry) {
  var empty = document.getElementById('requestLogEmpty');
  if (empty) empty.style.display = 'none';

  /* Remove loading skeletons */
  var skels = document.querySelectorAll('.skeleton');
  for (var i = 0; i < skels.length; i++) {
    skels[i].remove();
  }

  var container = document.getElementById('requestLogContainer');
  var entryId = entry.id || entry.request_id;
  var existing = logEntryMap[entryId];

  if (existing) {
    /* Update existing entry in-place */
    var el = document.getElementById(existing);
    if (el) el.innerHTML = renderEntryHtml(entry);
    return;
  }

  /* Create new entry element */
  var divId = 'req-' + entryId;
  var div = document.createElement('div');
  div.className = 'req-entry';
  div.id = divId;
  div.innerHTML = renderEntryHtml(entry);

  /* Prepend to container */
  container.insertBefore(div, container.firstChild || null);
  logEntryMap[entryId] = divId;
  logEntries.unshift(divId);

  /* Enforce max visible count - push excess to hidden store */
  while (logEntries.length > MAX_VISIBLE_ENTRIES) {
    var excess = logEntries.pop();
    var excessEl = document.getElementById(excess);
    if (excessEl) {
      excessEl.style.display = 'none';
      hiddenEntries.push(excess);
    }
  }

  updateCounts();
}

/* ── Update counters and Load More button ── */
function updateCounts() {
  var total = logEntries.length + hiddenEntries.length;
  var countEl = document.getElementById('entryCount');
  if (countEl) countEl.textContent = total + (total === 1 ? ' entry' : ' entries');

  var loadMoreBtn = document.getElementById('loadMoreBtn');
  var hiddenCountEl = document.getElementById('hiddenCount');
  if (hiddenEntries.length > 0) {
    loadMoreBtn.style.display = '';
    if (hiddenCountEl) hiddenCountEl.textContent = hiddenEntries.length;
  } else {
    loadMoreBtn.style.display = 'none';
  }
}

/* ── Load More ── */
function loadMore() {
  var batch = hiddenEntries.splice(0, 5);
  for (var i = 0; i < batch.length; i++) {
    var el = document.getElementById(batch[i]);
    if (el) {
      el.style.display = '';
      logEntries.push(batch[i]);
    }
  }
  /* Re-enforce max if needed (trim oldest from visible) */
  while (logEntries.length > MAX_VISIBLE_ENTRIES) {
    var excess = logEntries.pop();
    var excessEl = document.getElementById(excess);
    if (excessEl) {
      excessEl.style.display = 'none';
      hiddenEntries.push(excess);
    }
  }
  updateCounts();
}

/* ── Clear Log ── */
function clearLog() {
  var container = document.getElementById('requestLogContainer');
  var entries = container.querySelectorAll('.req-entry');
  for (var i = 0; i < entries.length; i++) {
    entries[i].remove();
  }
  logEntries = [];
  logEntryMap = {};
  hiddenEntries = [];

  var empty = document.getElementById('requestLogEmpty');
  if (empty) empty.style.display = '';

  updateCounts();
}

/* ── Toggle foldable section ── */
function toggleFold(header) {
  header.classList.toggle('collapsed');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('collapsed');
}

/* ── Init ── */
function init() {
  /* Connect SSE for live log stream */
  connectSSE();

  /* Fetch any existing entries from history */
  apiFetch('/log/json').then(function(data) {
    if (Array.isArray(data) && data.length > 0) {
      /* Add in reverse order so newest ends up on top */
      for (var i = data.length - 1; i >= 0; i--) {
        addRequestEntry(data[i]);
      }
    }
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
