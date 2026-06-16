import { sidebarHtml } from './sidebar.ts';

export const logsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — Request Log</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/logs.css">


</head>
<body>
<div class="dashboard-layout">
${sidebarHtml('logs')}
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
      <div class="empty-state" id="requestLogEmpty">No requests yet</div>
    </div>

    <!-- Load More Button (hidden by default) -->
    <button class="load-more-btn" id="loadMoreBtn" onclick="loadMore()" style="display:none">
      Load More (<span id="hiddenCount">0</span> hidden)
    </button>
  </main>
</div>


  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/logs.js"></script>
</body>
</html>`;
