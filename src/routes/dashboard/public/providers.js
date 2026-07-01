/*
 * providers.js — JavaScripts for /dashboard/providers and /dashboard/providers/:key
 *
 * If window.PROVIDER_KEY is set, this is an individual provider page.
 * Loads accounts, renders the table, handles add/login/remove/toggle.
 *
 * Provider list page relies on shared.js for dark mode toggle only (cards are server-rendered).
 */

var PROVIDER_KEY = window.PROVIDER_KEY || null;

function fmtTTL(ms) {
  if (ms == null || ms < 0) return '\u2014';
  var m = Math.floor(ms / 60000),
    h = Math.floor(m / 60);
  m %= 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  if (!container) return;
  var toasts = container.querySelectorAll('.toast');
  while (toasts.length >= 5) {
    toasts[0].remove();
    toasts = container.querySelectorAll('.toast');
  }
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function () {
    if (toast.parentNode) toast.remove();
  }, 3500);
}

function setError(msg) {
  var box = document.getElementById('errorBox');
  if (!box) return;
  if (msg) {
    box.textContent = msg;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}

function providerStatusBadge(status) {
  var dots = {
    live: 'live',
    expired: 'expired',
    connecting: 'connecting',
    pending: 'pending',
    disconnected: 'disconnected',
    captcha: 'captcha',
    waf: 'waf',
    bot_detected: 'captcha',
    unknown: 'unknown',
  };
  var dotClass = dots[status] || 'unknown';
  var labels = {
    live: 'Live',
    expired: 'Expired',
    connecting: 'Connecting',
    pending: 'Pending',
    disconnected: '\u2014',
    captcha: 'Bot Detect',
    waf: 'WAF Block',
    bot_detected: 'Bot Detect',
    unknown: 'Unknown',
  };
  var label = labels[status] || 'Unknown';
  return '<span class="prov-status"><span class="prov-dot ' + dotClass + '"></span>' + label + '</span>';
}

function makeThrottleBadge(acct) {
  if (acct.throttled) {
    var label = 'Throttled';
    if (acct.throttledUnlockAt) {
      var unlockTime = new Date(acct.throttledUnlockAt);
      var timeStr = unlockTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      label += ' until ' + timeStr;
    } else if (acct.throttledRemainingMs != null) {
      label += ' ' + fmtTTL(acct.throttledRemainingMs);
    }
    return '<span class="badge badge-warning">' + label + '</span>';
  }
  return '<span class="badge badge-neutral">OK</span>';
}

/* ── Render provider table ── */
function renderTable(accts) {
  var tableBody = document.getElementById('provBody');
  var emptyEl = document.getElementById('provEmpty');
  var countEl = document.getElementById('providerCount');
  if (!tableBody) return;

  if (!Array.isArray(accts) || accts.length === 0) {
    tableBody.innerHTML = '';
    emptyEl.style.display = '';
    if (countEl) countEl.textContent = '';
    return;
  }

  emptyEl.style.display = 'none';
  if (countEl) countEl.textContent = accts.length + ' total';

  var pk = PROVIDER_KEY;
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var provAuth = a.providerAuth && a.providerAuth[pk];
    var status = (provAuth && provAuth.status) || 'disconnected';
    var isLive = status === 'live';

    // Login buttons: auto-login + manual login
    var loginBtns = '';
    if (isLive) {
      loginBtns = '<button class="prov-login-btn logged-in" disabled>Logged In</button>';
    } else {
      if (pk === 'qwen') {
        loginBtns =
          '<button class="prov-login-btn" data-action="auto-login" data-email="' +
          escHtml(a.email) +
          '" data-provider="' +
          pk +
          '">Auto</button>' +
          '<button class="prov-login-btn" data-action="login" data-email="' +
          escHtml(a.email) +
          '" data-provider="' +
          pk +
          '">Login</button>';
      } else {
        loginBtns =
          '<button class="prov-login-btn" data-action="auto-login" data-email="' +
          escHtml(a.email) +
          '" data-provider="' +
          pk +
          '">Auto</button>' +
          '<button class="prov-login-btn" data-action="login" data-email="' +
          escHtml(a.email) +
          '" data-provider="' +
          pk +
          '">Login</button>';
      }
    }

    var cols = '';
    cols += '<td class="email-cell">' + escHtml(a.email) + '</td>';
    cols += '<td>' + providerStatusBadge(status) + '</td>';
    cols += '<td>' + (a.inFlight || 0) + '</td>';
    cols += '<td>' + (a.totalRequests || 0) + '</td>';
    var ttl = provAuth && provAuth.tokenExpiresInMs;
    cols += '<td>' + (ttl != null ? fmtTTL(ttl) : '\u2014') + '</td>';
    cols += '<td>' + makeThrottleBadge(a) + '</td>';

    // Disabled toggle
    var providerDisabled = a.disabledProviders && a.disabledProviders.indexOf(pk) !== -1;
    cols +=
      '<td><span class="toggle-trigger" onclick="handleToggleProviderDisabled(event,\'' +
      escHtml(a.email) +
      "','" +
      pk +
      "'," +
      providerDisabled +
      ')"><span class="toggle-track' +
      (providerDisabled ? ' active' : '') +
      '"><span class="toggle-thumb"></span></span></span></td>';

    cols +=
      '<td><div class="action-cell">' +
      loginBtns +
      '<button class="account-btn small danger" data-action="remove-producer" data-email="' +
      escHtml(a.email) +
      '" data-provider="' +
      pk +
      '">Remove</button>' +
      '</div></td>';

    rows += '<tr>' + cols + '</tr>';
  }
  tableBody.innerHTML = rows;
}

/* ── Load accounts ── */
async function loadAccounts() {
  var data = await apiFetch('/accounts');
  if (!Array.isArray(data)) {
    var tbody = document.getElementById('provBody');
    if (tbody) tbody.innerHTML = '';
    return;
  }
  var pk = PROVIDER_KEY;
  var filtered = data.filter(function (a) {
    return a.configuredProviders && a.configuredProviders.indexOf(pk) !== -1;
  });
  renderTable(filtered);

  // Auto-login for disconnected accounts
  autoLoginProvider(filtered, pk);
}

/* ── Auto-login endpoints ── */
var autoProviderEndpoints = {
  qwen: '/api/accounts/EMAIL_PLACEHOLDER/login',
  deepseek: '/api/accounts/EMAIL_PLACEHOLDER/auto-login/deepseek',
  glm: '/api/accounts/EMAIL_PLACEHOLDER/auto-login/glm',
};

var manualProviderEndpoints = {
  qwen: '/api/accounts/EMAIL_PLACEHOLDER/autofill',
  deepseek: '/api/accounts/EMAIL_PLACEHOLDER/login/deepseek',
  glm: '/api/accounts/EMAIL_PLACEHOLDER/login/glm',
};

function autoLoginEndpoint(email, provider) {
  return (autoProviderEndpoints[provider] || '').replace('EMAIL_PLACEHOLDER', encodeURIComponent(email));
}

function manualLoginEndpoint(email, provider) {
  return (manualProviderEndpoints[provider] || '').replace('EMAIL_PLACEHOLDER', encodeURIComponent(email));
}

/* ── Handle login ── */
function handleProviderLogin(email, provider, action) {
  var isAuto = action === 'auto-login';
  setError(null);

  if (isAuto) {
    autoLoginForProvider(email, provider);
  } else {
    (async function () {
      try {
        var ep = manualLoginEndpoint(email, provider);
        var res = await fetch(ep, { method: 'GET', headers: authHeaders() });
        var result;
        try { result = await res.json(); } catch { result = null; }
        if (!res.ok) throw new Error(result && result.error ? result.error.message : provider + ' login failed (' + res.status + ')');
        showToast('Browser opened for ' + email + '. Complete login in the browser window.', 'info');
        pollProviderLogin(email, provider, 90);
      } catch (e) {
        setError(e.message);
        showToast(e.message, 'error');
      }
    })();
  }
}

/* ── Poll provider login ── */
var activeProviderPollTimers = {};
function pollProviderLogin(email, provider, maxAttempts) {
  var timerId = email + '-' + provider;
  if (activeProviderPollTimers[timerId]) {
    clearInterval(activeProviderPollTimers[timerId]);
    delete activeProviderPollTimers[timerId];
  }
  var attempt = 0;
  var timer = setInterval(async function () {
    attempt++;
    try {
      var data = await apiFetch('/accounts');
      if (!Array.isArray(data)) return;
      for (var i = 0; i < data.length; i++) {
        if (
          data[i].email === email &&
          data[i].providerAuth &&
          data[i].providerAuth[provider] &&
          data[i].providerAuth[provider].status === 'live'
        ) {
          clearInterval(timer);
          delete activeProviderPollTimers[timerId];
          showToast(provider.charAt(0).toUpperCase() + provider.slice(1) + ' login completed for ' + email, 'success');
          loadAccounts();
          return;
        }
      }
    } catch {
      clearInterval(timer);
      delete activeProviderPollTimers[timerId];
    }
    if (attempt >= maxAttempts) {
      clearInterval(timer);
      delete activeProviderPollTimers[timerId];
      loadAccounts();
    }
  }, 2000);
  activeProviderPollTimers[timerId] = timer;
}

/* ── Auto-login ── */
async function autoLoginForProvider(email, provider) {
  try {
    var ep = autoLoginEndpoint(email, provider);
    var res = await fetch(ep, { method: 'GET', headers: authHeaders() });
    var result;
    try { result = await res.json(); } catch { result = null; }
    if (!res.ok) {
      showToast(provider + ' auto-login failed (' + res.status + ')', 'warning');
      return;
    }
    if (result.status === 'success') {
      pollProviderLogin(email, provider, 15);
    } else if (result.status === 'captcha') {
      showToast(provider + ': ' + (result.message || 'Bot detection \u2014 click Login to complete manually'), 'warning');
      loadAccounts();
    } else {
      showToast(result.message || provider + ' auto-login failed', 'warning');
      loadAccounts();
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* ── Auto-login on page load ── */
var autoTriggered = {};
function autoLoginProvider(accts, pk) {
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var key = a.email + '-' + pk;
    if (autoTriggered[key]) continue;
    var provAuth = a.providerAuth && a.providerAuth[pk];
    var status = (provAuth && provAuth.status) || 'disconnected';
    if (status === 'live') {
      autoTriggered[key] = true;
      continue;
    }
    autoTriggered[key] = true;
    setTimeout(
      (function (em, prov) {
        return function () { autoLoginForProvider(em, prov); };
      })(a.email, pk),
      i * 3000,
    );
  }
}

/* ── Add Account ── */
function handleAdd(email, password) {
  var btn = document.getElementById('addBtn');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  setError(null);
  (async function () {
    try {
      var pk = PROVIDER_KEY;
      var res = await fetch('/api/accounts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({
          email: email,
          password: password,
          providers: [pk],
        }),
      });
      var result;
      try { result = await res.json(); } catch { result = null; }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Failed to add account (' + res.status + ')');
      }
      if (result.loginSucceeded) {
        showToast('Account added and logged in: ' + email, 'success');
        pollProviderLogin(email, pk, 15);
      } else {
        showToast(result.loginError || 'Account added but login failed. Click Login to open browser.', 'warning');
        pollProviderLogin(email, pk, 15);
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

/* ── Remove account ── */
function handleRemove(email, provider) {
  document.getElementById('confirmEmail').textContent = escHtml(email);
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmYes').onclick = async function () {
    document.getElementById('confirmOverlay').classList.remove('open');
    setError(null);
    try {
      var url = '/api/accounts/' + encodeURIComponent(email) + '/provider/' + encodeURIComponent(provider);
      var res = await fetch(url, { method: 'DELETE', headers: authHeaders() });
      var result;
      try { result = await res.json(); } catch { result = null; }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Failed to remove (' + res.status + ')');
      }
      showToast(provider + ' removed from ' + email, 'success');
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    }
  };
  document.getElementById('confirmNo').onclick = function () {
    document.getElementById('confirmOverlay').classList.remove('open');
  };
}

/* ── Toggle provider disabled ── */
async function handleToggleProviderDisabled(event, email, provider, currentlyDisabled) {
  event.stopPropagation();
  var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ disabledProviders: currentlyDisabled ? [] : [provider] }),
  });
  if (res.ok) {
    showToast(email + ' ' + provider + ' ' + (currentlyDisabled ? 'enabled' : 'disabled'), 'success');
    loadAccounts();
  } else {
    var err = await res.json().catch(function () { return { error: 'Failed' }; });
    showToast(err.error || 'Failed to toggle', 'error');
  }
}

/* ── Init ── */
function init() {
  if (!PROVIDER_KEY) return; // Provider list page — no data loading needed

  loadAccounts();

  var addForm = document.getElementById('addForm');
  if (addForm) {
    addForm.addEventListener('submit', function (e) {
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
  }

  // Button delegation on the table
  var provBody = document.getElementById('provBody');
  if (provBody) {
    provBody.parentElement.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var email = btn.getAttribute('data-email');
      var action = btn.getAttribute('data-action');
      var provider = btn.getAttribute('data-provider');
      if (!email) return;
      if (action === 'remove-provider') handleRemove(email, provider || PROVIDER_KEY);
      else if (action === 'login' || action === 'auto-login') handleProviderLogin(email, provider || PROVIDER_KEY, action);
    });
  }

  // Close modal on overlay click
  var overlay = document.getElementById('confirmOverlay');
  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === this) this.classList.remove('open');
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
