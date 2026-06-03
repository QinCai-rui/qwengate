export const networkHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — Network Debug</title>
<script></script>
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

/* Sidebar */
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
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px}
.page-header h1{font-size:1.25rem;font-weight:700;letter-spacing:-0.01em;display:flex;align-items:center;gap:10px;font-family:var(--display);color:var(--text-display)}
.page-header h1 .count-badge{font-size:0.75rem;font-weight:500;background:var(--accent-soft);color:var(--accent);padding:2px 10px;border-radius:9999px;font-family:var(--mono)}
.live-indicator{display:flex;align-items:center;gap:6px;font-size:0.7rem;color:var(--success);text-transform:uppercase;letter-spacing:0.05em;font-weight:500}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;display:inline-block}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.85)}}

/* Controls */
.controls{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.controls .filter-select{padding:6px 10px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:0.75rem;font-family:var(--mono);cursor:pointer;outline:none;transition:border-color 0.15s;box-shadow:var(--clay-puff)}
.controls .filter-select:focus{border-color:var(--accent)}
.controls .entry-count{font-size:0.75rem;color:var(--text-secondary);font-family:var(--mono)}

/* Table */
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--clay-shadow)}
table{width:100%;border-collapse:collapse;font-size:0.8125rem}
thead th{text-align:left;padding:12px 10px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap;background:var(--bg-card);position:sticky;top:0;z-index:1}
thead th:first-child{padding-left:16px}
thead th:last-child{padding-right:16px}
tbody td{padding:10px;border-bottom:1px solid var(--border);color:var(--text-primary);vertical-align:middle}
tbody tr:last-child>td{border-bottom:none}
tbody tr.parent-row{cursor:pointer;transition:background 0.1s}
tbody tr.parent-row:hover{background:var(--bg-elevated)}
tbody tr.parent-row.expanded{background:var(--bg-elevated)}
tbody tr.detail-row td{padding:0;border-bottom:1px solid var(--border)}

/* Badges */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:500;white-space:nowrap;gap:4px;line-height:1.4;box-shadow:var(--clay-shadow-sm)}
.badge-success{background:var(--success-soft);color:var(--success)}
.badge-danger{background:var(--danger-soft);color:var(--danger)}
.badge-warning{background:var(--warning-soft);color:var(--warning)}
.badge-accent{background:var(--accent-soft);color:var(--accent)}
.badge-neutral{background:var(--bg-elevated);color:var(--text-secondary)}

/* Detail expand */
.detail-box{padding:16px 20px;background:var(--bg-elevated);border-top:1px solid var(--border)}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:768px){.detail-grid{grid-template-columns:1fr}}
.detail-section{border:1px solid var(--border);border-radius:6px;overflow:hidden}
.detail-section .section-header{cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;padding:8px 10px;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500;background:var(--bg-card);transition:color 0.15s}
.detail-section .section-header:hover{color:var(--text-primary)}
.detail-section .section-arrow{display:inline-block;transition:transform 0.2s;font-size:9px;width:12px}
.detail-section .section-header.open .section-arrow{transform:rotate(90deg)}
.detail-section .section-body{display:none;padding:0}
.detail-section .section-body.open{display:block}
.detail-section pre{margin:0;padding:10px;white-space:pre-wrap;word-break:break-all;font-family:var(--mono);font-size:0.7rem;line-height:1.6;color:var(--text-primary);max-height:250px;overflow:auto}

/* URL cell */
.url-cell{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:0.75rem;color:var(--text-secondary)}

/* Duration */
.duration-cell{font-family:var(--mono);font-size:0.75rem;font-variant-numeric:tabular-nums}
.duration-cell.fast{color:var(--success)}
.duration-cell.slow{color:var(--warning)}

/* Timestamp */
.ts-cell{font-family:var(--mono);font-size:0.7rem;color:var(--text-secondary);white-space:nowrap}

/* Empty / error states */
.empty-state{padding:48px 16px;text-align:center;color:var(--text-secondary);font-size:0.8125rem}
.error-state{padding:16px;text-align:center;color:var(--danger);font-size:0.8125rem}

/* Phase badges */
.phase-pending{background:var(--bg-elevated);color:var(--text-secondary)}
.phase-streaming{background:var(--accent-soft);color:var(--accent)}
.phase-completed{background:var(--success-soft);color:var(--success)}
.phase-error{background:var(--danger-soft);color:var(--danger)}

/* Category chips */
.cat-chat{background:rgba(224,139,110,0.12);color:#E08B6E}
.cat-auth{background:rgba(212,160,80,0.12);color:#d4a050}
.cat-models{background:rgba(125,171,125,0.12);color:#7dab7d}
.cat-other{background:var(--bg-elevated);color:var(--text-secondary)}

/* Method badge color overrides */
.badge-method-get{background:rgba(125,171,125,0.15);color:#7dab7d}
.badge-method-post{background:rgba(224,139,110,0.15);color:#E08B6E}
.badge-method-put{background:rgba(212,160,80,0.15);color:#d4a050}
.badge-method-delete{background:rgba(201,107,107,0.15);color:#c96b6b}
.badge-method-patch{background:rgba(212,160,80,0.15);color:#d4a050}

/* Small phase badge */
.phase-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;font-size:0.65rem;font-weight:500;font-family:var(--mono);text-transform:capitalize}

/* Row highlight animation */
@keyframes rowFade{from{background:var(--accent-soft)}to{background:transparent}}
tr.highlight td{animation:rowFade 1s ease}

/* Scroll container for table body */
.table-scroll{max-height:calc(100vh - 180px);overflow-y:auto}
.table-scroll tbody tr:last-child td{border-bottom:1px solid var(--border)}
.table-scroll tbody tr.detail-row:last-child td{border-bottom:none}

@media(max-width:600px){.main-content{padding:12px}.page-header h1{font-size:1rem}.url-cell{max-width:140px}.detail-box{padding:12px}.controls{gap:8px}}
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
      <a href="/dashboard/network" class="nav-link active">
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
  <h1>
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent)"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
    Network
    <span class="count-badge" id="entryCount">0</span>
  </h1>
</div>

<div class="controls">
  <label style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500">Filter</label>
  <select class="filter-select" id="methodFilter" onchange="onFilterChange()">
    <option value="">All Methods</option>
    <option value="GET">GET</option>
    <option value="POST">POST</option>
    <option value="PUT">PUT</option>
    <option value="PATCH">PATCH</option>
    <option value="DELETE">DELETE</option>
  </select>
  <select class="filter-select" id="statusFilter" onchange="onFilterChange()">
    <option value="">All Status</option>
    <option value="2xx">2xx Success</option>
    <option value="4xx">4xx Client Error</option>
    <option value="5xx">5xx Server Error</option>
  </select>
  <select class="filter-select" id="categoryFilter" onchange="onFilterChange()">
    <option value="">All Categories</option>
    <option value="chat">Chat</option>
    <option value="auth">Auth</option>
    <option value="models">Models</option>
    <option value="session-create">Session Create</option>
    <option value="session-delete">Session Delete</option>
    <option value="settings">Settings</option>
    <option value="other">Other</option>
  </select>
  <span class="entry-count" id="filteredCount"></span>
</div>

<div class="tbl-wrap">
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Method</th>
          <th>URL</th>
          <th>Status</th>
          <th>Duration</th>
          <th style="width:40px"></th>
        </tr>
      </thead>
      <tbody id="netBody"></tbody>
    </table>
  </div>
  <div class="empty-state" id="netEmpty" style="display:none">No network entries recorded yet</div>
  <div class="error-state" id="netError" style="display:none"></div>
</div>

  </main>
</div>

<script>
/* ── Helpers ── */
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function authHeaders() {
  return window.API_KEY ? { 'Authorization': 'Bearer ' + window.API_KEY } : {};
}

async function apiFetch(url) {
  try {
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}

function fmtTime(ts) {
  if (!ts) return '—';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + ' ' + ampm;
}

function fmtJson(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch(e) { return raw; }
  }
  try { return JSON.stringify(raw, null, 2); } catch(e) { return String(raw); }
}

function methodBadgeClass(method) {
  var m = (method || 'GET').toUpperCase();
  if (m === 'GET') return 'badge-method-get';
  if (m === 'POST') return 'badge-method-post';
  if (m === 'PUT') return 'badge-method-put';
  if (m === 'DELETE') return 'badge-method-delete';
  if (m === 'PATCH') return 'badge-method-patch';
  return 'badge-neutral';
}

function statusBadgeClass(status) {
  if (status >= 500) return 'badge-danger';
  if (status >= 400) return 'badge-warning';
  if (status >= 200 && status < 300) return 'badge-success';
  return 'badge-neutral';
}

function phaseBadgeClass(phase) {
  if (phase === 'completed') return 'phase-completed';
  if (phase === 'streaming') return 'phase-streaming';
  if (phase === 'error') return 'phase-error';
  return 'phase-pending';
}

function categoryCssClass(cat) {
  if (cat === 'chat') return 'cat-chat';
  if (cat === 'auth') return 'cat-auth';
  if (cat === 'models') return 'cat-models';
  return 'cat-other';
}

function durationClass(ms) {
  if (ms == null) return '';
  return ms > 3000 ? 'slow' : (ms > 500 ? 'slow' : 'fast');
}

function truncateUrl(url, maxLen) {
  if (!url) return '—';
  maxLen = maxLen || 60;
  if (url.length <= maxLen) return url;
  return url.substring(0, maxLen - 3) + '...';
}

/* ── State ── */
var allEntries = [];
var expandedRows = {};

/* ── Filter ── */
function onFilterChange() {
  renderNetworkTable(allEntries);
}

function getFilters() {
  return {
    method: document.getElementById('methodFilter').value.toUpperCase(),
    status: document.getElementById('statusFilter').value,
    category: document.getElementById('categoryFilter').value
  };
}

function matchesFilters(entry, filters) {
  if (filters.method) {
    var method = (entry.request && entry.request.method) || entry.method || 'GET';
    if (method.toUpperCase() !== filters.method) return false;
  }
  if (filters.status) {
    var status = (entry.response && entry.response.status) || entry.status || 0;
    var cat = filters.status;
    if (cat === '2xx' && (status < 200 || status >= 300)) return false;
    if (cat === '4xx' && (status < 400 || status >= 500)) return false;
    if (cat === '5xx' && (status < 500 || status >= 600)) return false;
  }
  if (filters.category) {
    var cat = entry.category || '';
    if (cat !== filters.category) return false;
  }
  return true;
}

/* ── Fetch ── */
async function fetchNetworkEntries() {
  var data = await apiFetch('/debug/network?limit=50');
  var emptyEl = document.getElementById('netEmpty');
  var errorEl = document.getElementById('netError');
  if (!data || !data.entries || !Array.isArray(data.entries)) {
    emptyEl.style.display = '';
    errorEl.style.display = 'none';
    allEntries = [];
    renderNetworkTable([]);
    document.getElementById('entryCount').textContent = '0';
    return;
  }
  emptyEl.style.display = 'none';
  errorEl.style.display = 'none';
  allEntries = data.entries;
  document.getElementById('entryCount').textContent = allEntries.length;
  renderNetworkTable(allEntries);
}

function renderNetworkTable(entries) {
  var tbody = document.getElementById('netBody');
  var filters = getFilters();
  var filtered = entries.filter(function(e) { return matchesFilters(e, filters); });
  var filteredCountEl = document.getElementById('filteredCount');
  if (filteredCountEl) {
    var total = entries.length;
    filteredCountEl.textContent = filtered.length === total ? total + ' entries' : filtered.length + ' of ' + total + ' entries';
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">No matching entries</div></td></tr>';
    return;
  }

  var html = '';
  for (var i = 0; i < filtered.length; i++) {
    var e = filtered[i];
    var idx = allEntries.indexOf(e);
    var detailId = 'net-detail-' + idx;

    var method = (e.request && e.request.method) || e.method || 'GET';
    var url = (e.request && e.request.url) || e.url || '';
    var status = (e.response && e.response.status) || e.status;
    var duration = (e.timing && e.timing.totalDuration) || e.duration;
    var ts = fmtTime(e.timestamp);
    var phase = e.phase || 'completed';

    var isExpanded = expandedRows[detailId] || false;

    html += '<tr class="parent-row' + (isExpanded ? ' expanded' : '') + '" onclick="toggleDetail(' + "'" + detailId + "'" + ', ' + idx + ')" data-idx="' + idx + '">'
      + '<td class="ts-cell">' + ts + '</td>'
      + '<td><span class="badge ' + methodBadgeClass(method) + '">' + escHtml(method.toUpperCase()) + '</span></td>'
      + '<td><div class="url-cell" title="' + escHtml(url) + '">' + escHtml(truncateUrl(url)) + '</div></td>'
      + '<td>'
      + (status != null ? '<span class="badge ' + statusBadgeClass(status) + '">' + status + '</span>' : '<span class="badge badge-neutral">—</span>')
      + ' <span class="phase-badge ' + phaseBadgeClass(phase) + '">' + escHtml(phase) + '</span>'
      + '</td>'
      + '<td class="duration-cell ' + durationClass(duration) + '">' + (duration != null ? Math.round(duration) + 'ms' : '—') + '</td>'
      + '<td style="text-align:right;color:var(--text-secondary);font-size:11px">' + (isExpanded ? '▲' : '▼') + '</td>'
      + '</tr>'
      + '<tr class="detail-row" id="' + detailId + '" style="display:' + (isExpanded ? 'table-row' : 'none') + '">'
      + '<td colspan="6"><div class="detail-box">'
      + renderEntryDetail(e)
      + '</div></td></tr>';
  }
  tbody.innerHTML = html;
}

/* ── Toggle Detail ── */
function toggleDetail(detailId, idx) {
  var row = document.getElementById(detailId);
  if (!row) return;
  var isVisible = row.style.display !== 'none';
  row.style.display = isVisible ? 'none' : 'table-row';
  expandedRows[detailId] = !isVisible;

  /* Also toggle expanded class on parent row */
  var parentRows = document.querySelectorAll('tr.parent-row[data-idx="' + idx + '"]');
  for (var i = 0; i < parentRows.length; i++) {
    parentRows[i].classList.toggle('expanded');
    var arrow = parentRows[i].querySelector('td:last-child');
    if (arrow) arrow.textContent = expandedRows[detailId] ? '▲' : '▼';
  }
}

/* ── Render Entry Detail ── */
function renderEntryDetail(entry) {
  var reqHeaders = (entry.request && entry.request.headers) || entry.requestHeaders;
  var reqBody = (entry.request && entry.request.bodyPreview) || entry.requestBody;
  var resHeaders = (entry.response && entry.response.headers) || entry.responseHeaders;
  var resBody = entry.response ? entry.response.body : (entry.responseBody || null);
  var stream = entry.stream;
  var timing = entry.timing;
  var cat = entry.category;
  var email = entry.accountEmail;

  var metaParts = [];
  if (cat) metaParts.push('<span class="badge ' + categoryCssClass(cat) + '">' + escHtml(cat) + '</span>');
  if (email) metaParts.push('<span class="badge badge-neutral">' + escHtml(email) + '</span>');
  if (timing && timing.ttfb != null) metaParts.push('<span style="font-size:0.7rem;color:var(--text-secondary);font-family:var(--mono)">TTFB: ' + Math.round(timing.ttfb) + 'ms</span>');
  if (timing && timing.chunksPerSecond != null) metaParts.push('<span style="font-size:0.7rem;color:var(--text-secondary);font-family:var(--mono)">' + timing.chunksPerSecond.toFixed(1) + 'ch/s</span>');

  var html = '';
  if (metaParts.length > 0) {
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center">'
      + metaParts.join('')
      + (stream && stream.totalChunks ? '<span style="font-size:0.7rem;color:var(--text-secondary);font-family:var(--mono)">' + stream.totalChunks + ' chunks</span>' : '')
      + '</div>';
  }

  html += '<div class="detail-grid">';

  /* Request Headers */
  html += '<div class="detail-section">'
    + '<div class="section-header open" onclick="toggleSection(this)"><span class="section-arrow">▶</span> Request Headers</div>'
    + '<div class="section-body open"><pre>' + escHtml(reqHeaders ? JSON.stringify(reqHeaders, null, 2) : '(none)') + '</pre></div>'
    + '</div>';

  /* Request Body */
  html += '<div class="detail-section">'
    + '<div class="section-header" onclick="toggleSection(this)"><span class="section-arrow">▶</span> Request Body</div>'
    + '<div class="section-body"><pre>' + escHtml(reqBody ? fmtJson(reqBody) : '(empty)') + '</pre></div>'
    + '</div>';

  /* Response Headers */
  html += '<div class="detail-section">'
    + '<div class="section-header" onclick="toggleSection(this)"><span class="section-arrow">▶</span> Response Headers</div>'
    + '<div class="section-body"><pre>' + escHtml(resHeaders ? JSON.stringify(resHeaders, null, 2) : '(none)') + '</pre></div>'
    + '</div>';

  /* Response Body */
  html += '<div class="detail-section">'
    + '<div class="section-header" onclick="toggleSection(this)"><span class="section-arrow">▶</span> Response Body</div>'
    + '<div class="section-body"><pre>' + escHtml(resBody ? fmtJson(resBody) : '(empty)') + '</pre></div>'
    + '</div>';

  /* Stream chunks if present */
  if (stream && stream.chunks && stream.chunks.length > 0) {
    html += '<div class="detail-section" style="grid-column:1/-1">'
      + '<div class="section-header" onclick="toggleSection(this)"><span class="section-arrow">▶</span> Stream Chunks (' + stream.totalChunks + ' total, showing ' + stream.chunks.length + ')</div>'
      + '<div class="section-body"><pre>' + escHtml(stream.chunks.join('\\n')) + '</pre></div>'
      + '</div>';
  }

  /* Errors if present */
  if (entry.errors && entry.errors.length > 0) {
    html += '<div class="detail-section" style="grid-column:1/-1">'
      + '<div class="section-header open" onclick="toggleSection(this)"><span class="section-arrow">▶</span> Errors (' + entry.errors.length + ')</div>'
      + '<div class="section-body open" style="background:var(--danger-soft)"><pre style="color:var(--danger)">' + escHtml(entry.errors.join('\\n')) + '</pre></div>'
      + '</div>';
  }

  html += '</div>';
  return html;
}

/* ── Section Toggle ── */
function toggleSection(header) {
  header.classList.toggle('open');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('open');
}

/* ── Init ── */
function init() {
  fetchNetworkEntries();
  setInterval(fetchNetworkEntries, 2000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
</script>
</body>
</html>`;
