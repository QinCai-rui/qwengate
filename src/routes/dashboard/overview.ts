export const overviewHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — Dashboard Overview</title>
<script></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Montserrat:wght@400;500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap');
:root{--bg-primary:#F5F1EA;--bg-card:#E9E2D6;--bg-elevated:#DDD4C6;--border:#C9BFAE;--text-primary:#1a1615;--text-secondary:#8a7f6f;--text-display:#4a4540;--accent:#5E9D5C;--accent-soft:rgba(94,157,92,0.2);--success:#3D8B3D;--success-soft:rgba(61,139,61,0.15);--warning:#C8983A;--warning-soft:rgba(200,152,58,0.15);--danger:#C96B6B;--danger-soft:rgba(201,107,107,0.15);--radius:16px;--radius-sm:10px;--sidebar-width:220px;--font:'Montserrat',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--display:'Poppins',sans-serif;--mono:'JetBrains Mono','SF Mono',Monaco,Consolas,monospace;--clay-shadow:6px 6px 12px rgba(0,0,0,0.06),-2px -2px 6px rgba(255,255,255,0.5);--clay-shadow-sm:3px 3px 6px rgba(0,0,0,0.04),-1px -1px 3px rgba(255,255,255,0.4);--clay-puff:inset 2px 2px 4px rgba(255,255,255,0.6),inset -2px -2px 4px rgba(0,0,0,0.04)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--font);background:var(--bg-primary);color:var(--text-primary);line-height:1.5;min-height:100vh}

/* Dashboard Layout */
.dashboard-layout{display:flex;min-height:100vh}

/* Sidebar */
.sidebar{width:var(--sidebar-width);min-width:var(--sidebar-width);background:var(--bg-card);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100}
.sidebar-header{padding:20px 16px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px}
.sidebar-header h1{font-size:1rem;font-family:var(--display);font-weight:700;color:var(--text-primary);letter-spacing:-0.01em}
.sidebar-nav{flex:1;padding:8px;display:flex;flex-direction:column;gap:2px}
.sidebar-footer{padding:14px 16px;border-top:1px solid var(--border);font-size:0.75rem;color:var(--text-secondary);font-family:var(--mono)}

/* Live Indicator */
.live-indicator{display:flex;align-items:center;gap:6px;font-size:0.7rem;color:var(--success);text-transform:uppercase;letter-spacing:0.05em;font-weight:500}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;display:inline-block}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.85)}}

/* Nav Items */
.nav-link{display:flex;align-items:center;gap:10px;padding:8px 12px;border:none;border-radius:var(--radius-sm);background:transparent;color:var(--text-secondary);font-size:0.8125rem;font-weight:500;cursor:pointer;transition:all 0.15s;white-space:nowrap;font-family:var(--font);width:100%;text-align:left;text-decoration:none;box-shadow:var(--clay-shadow-sm)}
.nav-link:hover{color:var(--text-primary);background:var(--bg-elevated)}
.nav-link.active{background:var(--accent);color:#fff;box-shadow:var(--clay-shadow-sm)}
.nav-link svg{flex-shrink:0}

/* Main Content */
.main-content{flex:1;margin-left:var(--sidebar-width);padding:24px;width:calc(100% - var(--sidebar-width))}

/* Page Header */
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px}
.page-header h1{font-size:1.35rem;font-family:var(--display);font-weight:700;letter-spacing:-0.02em;color:var(--text-primary)}
.page-header-right{display:flex;align-items:center;gap:16px}
.uptime-text{font-family:var(--mono);font-size:0.78rem;color:var(--text-secondary)}

/* Overview Grid Layout */
.overview-grid{display:grid;grid-template-columns:2fr 1fr;gap:16px;align-items:start}
.overview-left,.overview-right{display:flex;flex-direction:column;gap:12px}
@media(max-width:900px){.overview-grid{grid-template-columns:1fr}}

/* KPI Grid */
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.kpi-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:4px;transition:border-color 0.2s,box-shadow 0.2s;box-shadow:var(--clay-shadow),var(--clay-puff)}
.kpi-card:hover{border-color:var(--accent);box-shadow:7px 7px 14px rgba(0,0,0,0.35),-3px -3px 7px rgba(255,255,255,0.04),var(--clay-puff)}
.kpi-label{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500}
.kpi-value{font-size:2rem;font-weight:700;line-height:1.1;color:var(--text-primary);font-variant-numeric:tabular-nums}
.kpi-sub{font-size:0.75rem;color:var(--text-secondary);font-family:var(--mono)}

/* Panel */
.panel{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:16px;box-shadow:var(--clay-shadow),var(--clay-puff)}
.panel:hover{box-shadow:7px 7px 14px rgba(0,0,0,0.35),-3px -3px 7px rgba(255,255,255,0.04),var(--clay-puff)}
.panel-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;cursor:pointer;user-select:none;border-bottom:1px solid transparent;transition:background 0.15s}
.panel-header:hover{background:var(--bg-elevated)}
.panel-header.open{border-bottom-color:var(--border)}
.panel-title{font-size:0.875rem;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:8px}
.panel-chevron{color:var(--text-secondary);transition:transform 0.25s ease;font-size:10px}
.panel-header.open .panel-chevron{transform:rotate(180deg)}
.panel-body{max-height:0;overflow:hidden;transition:max-height 0.35s ease}
.panel-body.open{max-height:99999px}
.panel-content{padding:0 16px 16px}

/* Tables */
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:0.8125rem}
thead th{text-align:left;padding:10px 8px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap}
tbody td{padding:10px 8px;border-bottom:1px solid var(--border);color:var(--text-primary);vertical-align:middle;word-break:break-all}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--bg-elevated)}

/* Badges */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:500;white-space:nowrap;gap:4px;line-height:1.4;box-shadow:var(--clay-shadow-sm)}
.badge-success{background:var(--success-soft);color:var(--success)}
.badge-danger{background:var(--danger-soft);color:var(--danger)}
.badge-warning{background:var(--warning-soft);color:var(--warning)}
.badge-accent{background:var(--accent-soft);color:var(--accent)}
.badge-neutral{background:var(--bg-elevated);color:var(--text-secondary)}

/* Session Pool */
.pool-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding-top:8px}
.pool-stat{text-align:center;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-sm);box-shadow:var(--clay-shadow),var(--clay-puff)}
.pool-stat-value{font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums}
.pool-stat-label{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin-top:2px}
.pool-bar{height:4px;background:var(--bg-elevated);border-radius:2px;margin-top:12px;overflow:hidden}
.pool-bar-fill{height:100%;border-radius:2px;transition:width 0.5s ease}

/* System Logs */
.sys-log-entry{display:flex;gap:10px;padding:6px 0;font-family:var(--mono);font-size:0.75rem;border-bottom:1px solid var(--border);align-items:flex-start}
.sys-log-entry:last-child{border-bottom:none}
.sys-log-ts{color:var(--text-secondary);white-space:nowrap;flex-shrink:0}
.sys-log-level{font-weight:600;width:44px;flex-shrink:0;text-transform:uppercase;font-size:0.65rem;padding-top:1px}
.sys-log-cat{color:var(--accent);white-space:nowrap;flex-shrink:0;min-width:80px}
.sys-log-msg{color:var(--text-primary);word-break:break-all}
.log-debug{color:#71717a}.log-info{color:#6366f1}.log-warn{color:#f59e0b}.log-error{color:#ef4444}

/* Empty State */
.empty-state{padding:24px 16px;text-align:center;color:var(--text-secondary);font-size:0.8125rem}

/* Bold/Display text */
.kpi-value, .page-header h1, .sidebar-header h1, .pool-stat-value{color:var(--text-display)}

/* Responsive */
@media(max-width:1100px){.overview-grid{grid-template-columns:1fr}}
@media(max-width:900px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.pool-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:768px){.dashboard-layout{flex-direction:column}.sidebar{position:relative;width:100%;min-width:0;height:auto;border-right:none;border-bottom:1px solid var(--border);flex-direction:row;align-items:center;padding:0 8px}.sidebar-header{border-bottom:none;padding:8px;flex-shrink:0}.sidebar-nav{flex-direction:row;padding:4px;overflow-x:auto;flex:1}.sidebar-footer{display:none}.main-content{margin-left:0;padding:16px}.nav-link{width:auto;white-space:nowrap;font-size:0.75rem;padding:6px 12px;justify-content:center}.kpi-grid{grid-template-columns:repeat(2,1fr)}.pool-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px){.kpi-grid{grid-template-columns:1fr}.pool-grid{grid-template-columns:repeat(2,1fr)}.main-content{padding:12px}.nav-link{padding:6px 10px;font-size:0.7rem}}
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
      <a href="/dashboard" class="nav-link active">
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
      <a href="/dashboard/settings" class="nav-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Settings</span>
      </a>
    </nav>
    <div class="sidebar-footer" id="uptimeDisplay">—</div>
  </aside>
  <main class="main-content">
    <div class="page-header">
      <h1>Dashboard Overview</h1>
      <div class="page-header-right">
        <span class="uptime-text">Uptime: <span id="headerUptime">—</span></span>
      </div>
    </div>

    <div class="overview-grid">
      <div class="overview-left">

        <!-- KPI Grid -->
        <div class="kpi-grid" id="kpiGrid">
          <div class="kpi-card"><span class="kpi-label">Total Accounts</span><span class="kpi-value" id="kpiTotalAccounts">—</span><span class="kpi-sub" id="kpiTotalAccountsSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Authenticated</span><span class="kpi-value" id="kpiAuthenticated">—</span><span class="kpi-sub" id="kpiAuthenticatedSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Active Sessions</span><span class="kpi-value" id="kpiActiveSessions">—</span><span class="kpi-sub" id="kpiActiveSessionsSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Queue</span><span class="kpi-value" id="kpiQueue">—</span><span class="kpi-sub" id="kpiQueueSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Total Requests</span><span class="kpi-value" id="kpiTotalRequests">—</span><span class="kpi-sub" id="kpiTotalRequestsSub"></span></div>
          <div class="kpi-card"><span class="kpi-label">Uptime</span><span class="kpi-value" id="kpiUptime">—</span><span class="kpi-sub" id="kpiUptimeSub"></span></div>
        </div>

        <!-- Session Pool -->
        <div class="panel">
          <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Session Pool</span><span class="panel-chevron">▼</span></div>
          <div class="panel-body open">
            <div class="panel-content">
              <div class="pool-grid" id="poolGrid">
                <div class="pool-stat"><div class="pool-stat-value" id="poolActive">—</div><div class="pool-stat-label">Active</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolWaiting">—</div><div class="pool-stat-label">Waiting</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolAvailable">—</div><div class="pool-stat-label">Available</div></div>
                <div class="pool-stat"><div class="pool-stat-value" id="poolTotal">—</div><div class="pool-stat-label">Total</div></div>
              </div>
              <div class="pool-bar"><div class="pool-bar-fill" id="poolBarFill" style="width:0%"></div></div>
            </div>
          </div>
        </div>

        <!-- Model Health -->
        <div class="panel">
          <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Model Health</span><span class="panel-chevron">▼</span></div>
          <div class="panel-body open">
            <div class="panel-content">
              <div class="tbl-wrap">
                <table id="modelTable">
                  <thead><tr><th>Model</th><th>Success</th><th>Errors</th><th>Rate</th><th>Last Activity</th></tr></thead>
                  <tbody id="modelBody"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

      </div>
      <div class="overview-right">

        <!-- System Logs -->
        <div class="panel">
          <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">System Logs</span><span class="panel-chevron">▼</span></div>
          <div class="panel-body open">
            <div class="panel-content" id="sysLogsContainer">
              <div class="empty-state" id="sysLogsEmpty">No system logs yet</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </main>
</div>

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
function fmtTime(ts) {
  if (!ts) return '—';
  var d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + ' ' + ampm;
}
function fmtDuration(seconds) {
  if (seconds == null || seconds < 0) return '—';
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  if (parts.length === 0 || s > 0) parts.push(s + 's');
  return parts.join(' ');
}
function togglePanel(header) {
  header.classList.toggle('open');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('open');
}

/* ── Fetch wrapper ── */
async function apiFetch(url) {
  try {
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}

/* ── Uptime tracking ── */
var uptimeSeconds = 0;
var uptimeBase = 0;

function updateUptime() {
  var elapsed = uptimeSeconds + Math.floor((Date.now() - uptimeBase) / 1000);
  var str = fmtDuration(elapsed);
  setText('kpiUptime', str);
  setText('kpiUptimeSub', '');
  setText('headerUptime', str);
  setText('uptimeDisplay', str);
}

/* ── KPI + Health ── */
async function refreshHealth() {
  var data = await apiFetch('/health');
  if (!data) return;
  var accts = data.accounts || {};
  var total = accts.total != null ? accts.total : 0;
  var avail = accts.available != null ? accts.available : 0;
  setText('kpiTotalAccounts', total);
  setText('kpiTotalAccountsSub', avail + ' available');
  var pct = total > 0 ? Math.round((avail / total) * 100) : 0;
  setText('kpiAuthenticatedSub', pct + '% available');

  /* uptime */
  if (data.uptime != null) {
    uptimeSeconds = data.uptime;
    uptimeBase = Date.now();
    updateUptime();
  }

  /* fetch accounts for authenticated count */
  var acctData = await apiFetch('/accounts');
  if (Array.isArray(acctData)) {
    var authed = 0;
    var totalReqs = 0;
    for (var i = 0; i < acctData.length; i++) {
      if (acctData[i].authenticated) authed++;
      totalReqs += (acctData[i].totalRequests || 0);
    }
    setText('kpiAuthenticated', authed);
    var authPct = total > 0 ? Math.round((authed / total) * 100) : 0;
    setText('kpiAuthenticatedSub', authPct + '% of ' + total);
    setText('kpiTotalRequests', totalReqs);
  }
}

/* ── Pool Stats ── */
async function refreshPool() {
  var data = await apiFetch('/pool/stats');
  if (!data) return;
  var inUse = data.inUse || 0;
  var wait = data.waiting || 0;
  var avail = data.available || 0;
  var total = data.total || 0;
  setText('poolActive', inUse);
  setText('poolWaiting', wait);
  setText('poolAvailable', avail);
  setText('poolTotal', total);
  setText('kpiActiveSessions', inUse);
  setText('kpiActiveSessionsSub', 'of ' + total + ' sessions');
  setText('kpiQueue', wait);
  setText('kpiQueueSub', 'queued');
  var pct = total > 0 ? Math.min(100, Math.round((inUse / total) * 100)) : 0;
  var bar = document.getElementById('poolBarFill');
  bar.style.width = pct + '%';
  bar.style.background = pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--accent)';
}

/* ── Model Health ── */
async function refreshModelHealth() {
  var data = await apiFetch('/metrics/model-health');
  var tbody = document.getElementById('modelBody');
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No model activity recorded</div></td></tr>';
    return;
  }
  var keys = Object.keys(data).sort();
  var rows = '';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], m = data[k];
    var total = (m.successCount || 0) + (m.errorCount || 0);
    var rate = total > 0 ? Math.round(((m.successCount || 0) / total) * 100) : 0;
    var rateClass = rate >= 95 ? 'badge-success' : rate >= 80 ? 'badge-warning' : 'badge-danger';
    rows += '<tr>'
      + '<td>' + escHtml(k) + '</td>'
      + '<td>' + (m.successCount || 0) + '</td>'
      + '<td>' + (m.errorCount || 0) + '</td>'
      + '<td><span class="badge ' + rateClass + '">' + rate + '%</span></td>'
      + '<td>' + fmtTime(m.lastActivity) + '</td>'
      + '</tr>';
  }
  tbody.innerHTML = rows;
}

/* ── System Logs ── */
async function refreshSysLogs() {
  var data = await apiFetch('/system/logs?limit=10');
  var container = document.getElementById('sysLogsContainer');
  var empty = document.getElementById('sysLogsEmpty');
  if (!data || !Array.isArray(data) || data.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  var html = '';
  for (var i = 0; i < data.length; i++) {
    var l = data[i];
    var lvl = (l.level || 'info').toLowerCase();
    var cls = lvl === 'debug' ? 'log-debug' : lvl === 'warn' || lvl === 'warning' ? 'log-warn' : lvl === 'error' ? 'log-error' : 'log-info';
    html += '<div class="sys-log-entry">'
      + '<span class="sys-log-ts">' + fmtTime(l.timestamp) + '</span>'
      + '<span class="sys-log-level ' + cls + '">' + escHtml(lvl) + '</span>'
      + '<span class="sys-log-cat">' + escHtml(l.category || '') + '</span>'
      + '<span class="sys-log-msg">' + escHtml(l.message || '') + '</span>'
      + '</div>';
  }
  container.innerHTML = html;
  container.appendChild(empty);
}

/* ── Init ── */
function init() {
  refreshHealth();
  refreshPool();
  refreshModelHealth();
  refreshSysLogs();
  setInterval(refreshHealth, 2000);
  setInterval(refreshPool, 2000);
  setInterval(refreshSysLogs, 2000);
  setInterval(refreshModelHealth, 3000);
  setInterval(updateUptime, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
</script>
</body>
</html>`;
