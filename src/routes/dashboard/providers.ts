/*
 * File: providers.ts
 * Dashboard page — Providers hub and per-provider account management.
 *
 * /dashboard/providers         — provider cards with account counts
 * /dashboard/providers/:key     — individual provider account management
 *
 * Extensible: add entries to the PROVIDERS array below to register new providers.
 */
import { sidebarHtml } from './sidebar.ts';

/* ── Provider Metadata ──────────────────────────────────────────────── */

interface ProviderMeta {
  key: string;
  label: string;
  color: string;
  icon: string; // SVG path data for a 24x24 icon (inline, no <svg> wrapper)
  description: string;
  loginUrlLabel: string; // e.g. "chat.qwen.ai"
}

const PROVIDERS: ProviderMeta[] = [
  {
    key: 'qwen',
    label: 'Qwen',
    color: '#5D5EB5',
    icon: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    description: 'Free Qwen models (3.7-Max, 3-Max, 3-Plus) via chat.qwen.ai.',
    loginUrlLabel: 'chat.qwen.ai',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    color: '#4D6BFE',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    description: 'DeepSeek models (reasoner, chat) via chat.deepseek.com.',
    loginUrlLabel: 'chat.deepseek.com',
  },
  {
    key: 'glm',
    label: 'GLM',
    color: '#484a58',
    icon: '<polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>',
    description: 'GLM models (GLM-5, GLM-4) via chat.z.ai.',
    loginUrlLabel: 'chat.z.ai',
  },
];

/* ── Provider list page (cards) ─────────────────────────────────────── */

function providerCardHtml(p: ProviderMeta): string {
  return `<a href="/dashboard/providers/${p.key}" class="provider-card" style="--card-accent:${p.color}">
    <div class="provider-card-icon">
      <img src="/dashboard/static/${p.key === 'glm' ? 'zai-logo.png' : p.key + '-logo.png'}" width="28" height="28" alt="${p.label}">
    </div>
    <div class="provider-card-body">
      <h3>${p.label}</h3>
      <p>${p.description}</p>
      <span class="provider-card-link">Manage accounts <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg></span>
    </div>
  </a>`;
}

export const providersListHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenGate — Providers</title>
<link rel="stylesheet" href="/dashboard/static/shared.css">
<link rel="stylesheet" href="/dashboard/static/providers.css">
</head>
<body>
<div class="dashboard-layout">
${sidebarHtml('providers')}
  <main class="main-content">
    <div class="page-header" style="margin-bottom:24px">
      <h1>Providers</h1>
      <span style="font-size:0.8rem;color:var(--text-secondary)">Manage accounts per provider</span>
    </div>
    <div class="provider-cards">
      ${PROVIDERS.map(providerCardHtml).join('\n')}
    </div>
  </main>
</div>
<script src="/dashboard/static/shared.js"></script>
<script src="/dashboard/static/providers.js"></script>
</body>
</html>`;

/* ── Individual provider page ───────────────────────────────────────── */

function providerPageHtml(p: ProviderMeta): string {
  const colorVar = p.color;
  const key = p.key;
  const label = p.label;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenGate — ${label}</title>
<link rel="stylesheet" href="/dashboard/static/shared.css">
<link rel="stylesheet" href="/dashboard/static/providers.css">
</head>
<body>
<div class="dashboard-layout">
${sidebarHtml('providers')}
  <main class="main-content">
    <div class="page-header" style="margin-bottom:24px;display:flex;align-items:center;gap:12px">
      <a href="/dashboard/providers" class="back-link" style="display:inline-flex;align-items:center;gap:4px;color:var(--text-secondary);text-decoration:none;font-size:0.8rem">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
        Providers
      </a>
      <span style="color:var(--border)">/</span>
      <h1 style="color:${colorVar}">${label}</h1>
    </div>

    <!-- Error Display -->
    <div class="error-box" id="errorBox"></div>

    <!-- Add Account Form -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">Add Account to ${label}</span>
      </div>
      <div class="panel-body open">
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;background:var(--bg-elevated);padding:10px 14px;border-radius:var(--radius-sm)">
          <strong>⚠️ Best practice:</strong> Use <strong>3+ accounts</strong> for round-robin rotation. Do <strong>not</strong> use your personal ${label} account — create dedicated accounts.
        </div>
        <form class="account-form" id="addForm">
          <input type="email" class="account-input" id="emailInput" placeholder="Email" required autocomplete="email">
          <input type="password" class="account-input" id="passwordInput" placeholder="Password" required autocomplete="new-password">
          <button type="submit" class="account-btn primary" id="addBtn">Add Account</button>
        </form>
      </div>
    </div>

    <!-- Account Table -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">
          <span class="prov-dot live"></span> ${label} Accounts
        </span>
        <span id="providerCount" style="font-size:0.7rem;color:var(--text-secondary);font-weight:500"></span>
      </div>
      <div class="panel-body open">
        <div class="tbl-wrap">
          <table class="prov-table" id="provTable">
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
            <tbody id="provBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="provEmpty">No accounts configured for ${label}.</div>
      </div>
    </div>

    <!-- Models -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">Models</span>
      </div>
      <div class="panel-body open">
        <div id="modelsSection">
          <p class="text-secondary">Loading models...</p>
        </div>
      </div>
    </div>
  </main>
</div>

<!-- Confirmation Modal -->
<div class="modal-overlay" id="confirmOverlay">
  <div class="modal">
    <h3>Remove Account</h3>
    <p>Are you sure you want to remove <strong id="confirmEmail"></strong> from <strong>${label}</strong>? This cannot be undone.</p>
    <div class="modal-actions">
      <button class="modal-cancel" id="confirmNo">Cancel</button>
      <button class="modal-confirm" id="confirmYes">Remove</button>
    </div>
  </div>
</div>

<!-- Toast Container -->
<div class="toast-container" id="toastContainer"></div>

<script>window.PROVIDER_KEY = ${JSON.stringify(key)};</script>
<script src="/dashboard/static/shared.js"></script>
<script src="/dashboard/static/providers.js"></script>
</body>
</html>`;
}

/* ── Exports ─────────────────────────────────────────────────────────── */

/** Get HTML for an individual provider page by key. Returns null if unknown provider. */
export function getProviderPageHtml(key: string): string | null {
  const p = PROVIDERS.find((p) => p.key === key);
  if (!p) return null;
  return providerPageHtml(p);
}

/** List of known provider keys (for route registration). */
export function getProviderKeys(): string[] {
  return PROVIDERS.map((p) => p.key);
}
