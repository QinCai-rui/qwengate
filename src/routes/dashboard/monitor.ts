import { sidebarHtml } from './sidebar.ts';

export const monitorHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — Monitor</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/overview.css">
  <link rel="stylesheet" href="/dashboard/static/monitor.css">
  <link rel="stylesheet" href="/dashboard/static/usage.css">

</head>
<body>

<div class="dashboard-layout">
  ${sidebarHtml('monitor')}
  <main class="main-content">
    <div class="page-header">
      <h1>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent)"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Monitor &amp; Usage
      </h1>
      <div class="page-header-right">
        <span class="badge badge-accent" id="entryCountBadge">— entries</span>
      </div>
    </div>

    <!-- KPI Grid -->
    <div class="monitor-kpi-grid" id="kpiGrid">
      <div class="kpi-card"><span class="kpi-label">Total Requests</span><span class="kpi-value" id="kpiTotalReqs">—</span><span class="kpi-sub" id="kpiTotalReqsSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Success</span><span class="kpi-value" id="kpiSuccess">—</span><span class="kpi-sub" id="kpiSuccessSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Errors</span><span class="kpi-value" id="kpiErrors">—</span><span class="kpi-sub" id="kpiErrorsSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Avg Latency</span><span class="kpi-value" id="kpiAvgLat">—</span><span class="kpi-sub" id="kpiAvgLatSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Today</span><span class="kpi-value" id="kpiToday">—</span><span class="kpi-sub" id="kpiTodaySub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Last 7 Days</span><span class="kpi-value" id="kpiWeek">—</span><span class="kpi-sub" id="kpiWeekSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Rate-Limit Walls</span><span class="kpi-value" id="kpiWalls">—</span><span class="kpi-sub" id="kpiWallsSub"></span></div>
    </div>

    <!-- Usage: per-account breakdown -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Per-Account Usage</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="tbl-wrap">
            <table id="usageTable">
              <thead>
                <tr>
                  <th>Account</th>
                  <th class="num">Today</th>
                  <th class="num">Yesterday</th>
                  <th class="num">7 Days</th>
                  <th>Per-Model</th>
                </tr>
              </thead>
              <tbody id="usageBody"></tbody>
            </table>
          </div>
          <div class="empty-state" id="usageEmpty" style="display:none">No usage recorded yet — send a few requests and this fills up.</div>
        </div>
      </div>
    </div>

    <!-- Usage: model totals -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Model Totals (7 days)</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="tbl-wrap">
            <table id="modelTable">
              <thead>
                <tr>
                  <th>Model</th>
                  <th class="num">Requests</th>
                  <th class="num">Wall Hits</th>
                  <th>Last Wait</th>
                  <th class="num">Est. Daily Budget</th>
                </tr>
              </thead>
              <tbody id="modelBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Health: per-account metrics -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Account Health</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="monitor-info-row">
            <span id="timeRange">Collecting data...</span>
          </div>
          <div class="monitor-table-wrap" id="acctTableWrap">
            <div class="empty-monitor" id="emptyMonitor">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              <h3>No monitoring data yet</h3>
              <p>Data appears here once accounts start responding to requests.<br>Each request is recorded with its latency, mode, and success status.</p>
            </div>
            <table class="monitor-table" id="monitorTable" style="display:none">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Total</th>
                  <th>Success</th>
                  <th>Errors</th>
                  <th>Rate</th>
                  <th>Avg Lat</th>
                  <th>P95</th>
                  <th>Median</th>
                  <th>Modes</th>
                  <th>Recent Errors</th>
                </tr>
              </thead>
              <tbody id="monitorBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Error Summary -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Top Errors</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div id="errorSummaryContainer">
            <div class="empty-state" id="errorSummaryEmpty">No errors recorded</div>
            <ul class="error-list" id="errorSummaryList" style="display:none"></ul>
          </div>
        </div>
      </div>
    </div>

  </main>
</div>

  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/usage.js"></script>
  <script src="/dashboard/static/monitor.js"></script>
</body>
</html>`;
