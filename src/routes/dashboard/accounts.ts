import { sidebarHtml } from './sidebar.ts';

export const accountsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenGate — Accounts</title>
<link rel="stylesheet" href="/dashboard/static/shared.css">
<link rel="stylesheet" href="/dashboard/static/accounts.css">
</head>
<body>
<div class="dashboard-layout">
${sidebarHtml('accounts')}
  <main class="main-content">
    <div class="page-header">
      <h1>Accounts</h1>
    </div>

    <!-- Error Display -->
    <div class="error-box" id="errorBox"></div>

    <!-- Add Account Form -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">Add Account</span>
      </div>
      <div class="panel-body open">
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;background:var(--bg-elevated);padding:10px 14px;border-radius:var(--radius-sm)"><strong>⚠️ Best practice:</strong> Use <strong>3+ accounts</strong> for round-robin rotation to bypass cooldown limits. Do <strong>not</strong> use your personal Qwen account — create dedicated accounts.</div>
        <form class="account-form" id="addForm">
          <input type="email" class="account-input" id="emailInput" placeholder="Email" required autocomplete="email">
          <input type="password" class="account-input" id="passwordInput" placeholder="Password" required autocomplete="new-password">
          <input type="hidden" id="providersInput" value='["qwen"]'>
          <div class="provider-checks" id="providerChecks">
            <label class="provider-check checked qwen" data-provider="qwen">
              <span class="provider-check-dot"></span> Qwen
            </label>
            <label class="provider-check" data-provider="deepseek">
              <span class="provider-check-dot"></span> DeepSeek
            </label>
            <label class="provider-check" data-provider="glm">
              <span class="provider-check-dot"></span> GLM
            </label>
          </div>
          <button type="submit" class="account-btn" id="addBtn">Add Account</button>
        </form>
      </div>
    </div>

    <!-- Provider Tables -->
    <div id="providerPanels">

    <!-- Qwen Accounts -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">
          <span class="prov-dot live"></span> Qwen
        </span>
        <span id="qwenCount" style="font-size:0.7rem;color:var(--text-secondary);font-weight:500"></span>
      </div>
      <div class="panel-body open">
        <div class="tbl-wrap">
          <table class="prov-table" id="qwenTable">
            <thead>
              <tr>
                <th>Email</th>
                <th>Auth Status</th>
                <th>In Flight</th>
                <th>Total Reqs</th>
                <th>Token TTL</th>
                <th>Throttle</th>
                <th>Disabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="qwenBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="qwenEmpty">No accounts configured.</div>
      </div>
    </div>

    <!-- DeepSeek Accounts -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">
          <span class="prov-dot"></span> DeepSeek
        </span>
        <span id="deepseekCount" style="font-size:0.7rem;color:var(--text-secondary);font-weight:500"></span>
      </div>
      <div class="panel-body open">
        <div class="tbl-wrap">
          <table class="prov-table" id="deepseekTable">
            <thead>
              <tr>
                <th>Email</th>
                <th>Auth Status</th>
                <th>Throttle</th>
                <th>Disabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="deepseekBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="deepseekEmpty">No accounts configured.</div>
      </div>
    </div>

    <!-- GLM Accounts -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">
          <span class="prov-dot"></span> GLM
        </span>
        <span id="glmCount" style="font-size:0.7rem;color:var(--text-secondary);font-weight:500"></span>
      </div>
      <div class="panel-body open">
        <div class="tbl-wrap">
          <table class="prov-table" id="glmTable">
            <thead>
              <tr>
                <th>Email</th>
                <th>Auth Status</th>
                <th>Throttle</th>
                <th>Disabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="glmBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="glmEmpty">No accounts configured.</div>
      </div>
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


  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/accounts.js"></script>
</body>
</html>`;
