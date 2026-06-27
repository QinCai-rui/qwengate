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
  if (msg) {
    box.textContent = msg;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}

/* ── Provider Checkbox Toggle ── */
function updateProvidersInput() {
  var checks = document.querySelectorAll('#providerChecks .provider-check.checked');
  var providers = [];
  for (var i = 0; i < checks.length; i++) {
    providers.push(checks[i].getAttribute('data-provider'));
  }
  document.getElementById('providersInput').value = JSON.stringify(providers);
}

(function initProviderChecks() {
  var container = document.getElementById('providerChecks');
  if (!container) return;
  container.addEventListener('click', function (e) {
    var label = e.target.closest('.provider-check');
    if (!label) return;
    label.classList.toggle('checked');
    updateProvidersInput();
  });
})();

/* ── Provider Metadata ── */
var PROVIDERS = {
  qwen: { label: 'Qwen', key: 'qwen' },
  deepseek: { label: 'DeepSeek', key: 'deepseek' },
  glm: { label: 'GLM', key: 'glm' },
};

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

function renderProviderTable(accts, pk, cfg) {
  var tableBody = document.getElementById(cfg.tableBodyId);
  var emptyEl = document.getElementById(cfg.emptyId);
  if (!Array.isArray(accts) || accts.length === 0) {
    tableBody.innerHTML = '';
    emptyEl.style.display = '';
    setText(cfg.countId, '');
    return;
  }
  emptyEl.style.display = 'none';
  setText(cfg.countId, accts.length + ' total');
  var colorMap = { qwen: 'q', deepseek: 'd', glm: 'g' };
  var colorClass = colorMap[pk] || '';
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var provAuth = a.providerAuth && a.providerAuth[pk];
    var status = (provAuth && provAuth.status) || (provAuth && provAuth.lastError) || 'disconnected';
    var isLive = status === 'live';
    var loginBtn = isLive
      ? '<button class="prov-login-btn logged-in" disabled>Logged In</button>'
      : '<button class="prov-login-btn ' + colorClass + '" data-email="' + escHtml(a.email) + '" data-provider="' + pk + '">Login</button>';
    var cols = '';
    cols += '<td class="email-cell">' + escHtml(a.email) + '</td>';
    cols += '<td>' + providerStatusBadge(status) + '</td>';
    if (cfg.showStats) {
      cols += '<td>' + (a.inFlight || 0) + '</td>';
      cols += '<td>' + (a.totalRequests || 0) + '</td>';
    }
    if (cfg.showTokenTTL) {
      var ttl = provAuth && provAuth.tokenExpiresInMs;
      cols += '<td>' + (ttl != null ? fmtTTL(ttl) : '\u2014') + '</td>';
    }
    cols += '<td>' + makeThrottleBadge(a) + '</td>';
    var providerDisabled = a.disabledProviders && a.disabledProviders.indexOf(pk) !== -1;
    cols +=
      '<td>' +
      '<span class="toggle-trigger" onclick="handleToggleProviderDisabled(event,\'' +
      escHtml(a.email) +
      "','" +
      pk +
      "'," +
      providerDisabled +
      ')">' +
      '<span class="toggle-track' +
      (providerDisabled ? ' active' : '') +
      '">' +
      '<span class="toggle-thumb"></span>' +
      '</span></span></td>';
    cols +=
      '<td><div class="action-cell">' +
      loginBtn +
      '<button class="account-btn small danger" data-email="' +
      escHtml(a.email) +
      '" data-provider="' +
      pk +
      '" data-action="remove">Remove</button>' +
      '</div></td>';
    rows += '<tr>' + cols + '</tr>';
  }
  tableBody.innerHTML = rows;
}

/* ── Load Accounts ── */
async function loadAccounts() {
  var data = await apiFetch('/accounts');
  if (!Array.isArray(data)) {
    document.getElementById('qwenBody').innerHTML = '';
    document.getElementById('deepseekBody').innerHTML = '';
    document.getElementById('glmBody').innerHTML = '';
    return;
  }
  var provKeys = ['qwen', 'deepseek', 'glm'];
  var configs = {
    qwen: { tableBodyId: 'qwenBody', countId: 'qwenCount', emptyId: 'qwenEmpty', showStats: true, showTokenTTL: true },
    deepseek: { tableBodyId: 'deepseekBody', countId: 'deepseekCount', emptyId: 'deepseekEmpty', showStats: true, showTokenTTL: true },
    glm: { tableBodyId: 'glmBody', countId: 'glmCount', emptyId: 'glmEmpty', showStats: true, showTokenTTL: true },
  };
  for (var i = 0; i < provKeys.length; i++) {
    var pk = provKeys[i];
    var filtered = data.filter(function (a) {
      return a.configuredProviders && a.configuredProviders.indexOf(pk) !== -1;
    });
    renderProviderTable(filtered, pk, configs[pk]);
    /* Auto-login for Qwen and DeepSeek — not GLM */
    if (pk !== 'glm') autoLoginProvider(filtered, pk);
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
      var res = await fetch('/api/accounts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({
          email: email,
          password: password,
          providers: JSON.parse(document.getElementById('providersInput').value || '["qwen"]'),
        }),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(
          result && result.error && result.error.message ? result.error.message : 'Failed to add account (' + res.status + ')',
        );
      }
      if (result.loginSucceeded) {
        showToast('Account added and logged in: ' + email, 'success');
        pollProviderLogin(email, 'qwen', 15);
      } else {
        showToast(result.loginError || 'Account added but login failed. Click Login to open browser.', 'warning');
        pollProviderLogin(email, 'qwen', 15);
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

/* ── Remove Account / Provider ── */
function handleRemove(email, provider) {
  var message;
  if (provider) {
    message = 'Are you sure you want to remove <strong>' + escHtml(email) + '</strong> from <strong>' + escHtml(provider) + '</strong>?';
  } else {
    message = 'Are you sure you want to remove <strong>' + escHtml(email) + '</strong>? This cannot be undone.';
  }
  document.getElementById('confirmEmail').innerHTML = message;
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmYes').onclick = async function () {
    document.getElementById('confirmOverlay').classList.remove('open');
    setError(null);
    try {
      var url = '/api/accounts/' + encodeURIComponent(email);
      if (provider) {
        url += '/provider/' + encodeURIComponent(provider);
      }
      var res = await fetch(url, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Failed to remove (' + res.status + ')');
      }
      var successMsg = provider ? provider + ' removed from ' + email : 'Account removed: ' + email;
      showToast(successMsg, 'success');
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

/* ── Provider Manual Login ── */
var providerEndpoints = {
  qwen: '/autofill',
  deepseek: '/login/deepseek',
  glm: '/login/glm',
};

/* ── Auto-login endpoints (headless stealth, no browser window) ── */
var autoProviderEndpoints = {
  qwen: '/login',
  deepseek: '/auto-login/deepseek',
  glm: '/auto-login/glm',
};

function handleProviderLogin(email, provider) {
  var loginBtns = document.querySelectorAll('button[data-email="' + escHtml(email) + '"][data-provider="' + provider + '"]');
  loginBtns.forEach(function (b) {
    b.disabled = true;
    b.textContent = 'Opening...';
  });
  setError(null);
  (async function () {
    try {
      var ep = providerEndpoints[provider] || '/autofill';
      var res = await fetch('/api/accounts/' + encodeURIComponent(email) + ep, {
        method: 'GET',
        headers: authHeaders(),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) throw new Error(result && result.error ? result.error.message : provider + ' login failed (' + res.status + ')');
      showToast('Browser opened for ' + email + '. Complete login in the browser window.', 'info');
      pollProviderLogin(email, provider, 90);
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    } finally {
      loginBtns.forEach(function (b) {
        b.disabled = false;
        b.textContent = 'Login';
      });
    }
  })();
}

/* ── Poll Provider Login ── */
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
      if (!Array.isArray(data)) {
        clearInterval(timer);
        delete activeProviderPollTimers[timerId];
        return;
      }
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

/* ── Toggle Disabled ── */
async function handleToggleDisabled(event, email, currentlyDisabled) {
  event.stopPropagation();
  var newDisabled = !currentlyDisabled;
  var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ disabled: newDisabled }),
  });
  if (res.ok) {
    showToast(email + ' ' + (newDisabled ? 'disabled' : 'enabled'), 'success');
    loadAccounts();
  } else {
    var err = await res.json().catch(function () {
      return { error: 'Failed' };
    });
    showToast(err.error || 'Failed to toggle', 'error');
  }
}

/* ── Toggle Provider Disabled ── */
async function handleToggleProviderDisabled(event, email, provider, currentlyDisabled) {
  event.stopPropagation();
  var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ disabledProviders: currentlyDisabled ? [] : [provider] }),
  });
  if (res.ok) {
    showToast(email + ' ' + provider + (currentlyDisabled ? ' enabled' : ' disabled'), 'success');
    loadAccounts();
  } else {
    var err = await res.json().catch(function () {
      return { error: 'Failed' };
    });
    showToast(err.error || 'Failed to toggle', 'error');
  }
}

async function autoLoginForProvider(email, provider) {
  try {
    var ep = autoProviderEndpoints[provider];
    if (!ep) return;
    var res = await fetch('/api/accounts/' + encodeURIComponent(email) + ep, {
      method: 'GET',
      headers: authHeaders(),
    });
    var result;
    try {
      result = await res.json();
    } catch {
      result = null;
    }
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

/* ── Auto-login tracking ── */
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
    // Stagger auto-login attempts to avoid launching multiple browsers at once
    setTimeout(
      (function (em, prov) {
        return function () {
          autoLoginForProvider(em, prov);
        };
      })(a.email, pk),
      i * 3000,
    );
  }
}

/* ── Init ── */
function init() {
  /* Load on start */
  loadAccounts();

  /* Add form submit */
  document.getElementById('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('emailInput').value.trim();
    var password = document.getElementById('passwordInput').value;
    if (!email || !password) {
      showToast('Email and password are required', 'error');
      return;
    }
    handleAdd(email, password);
    this.reset();
    updateProvidersInput();
  });

  /* Table button delegation */
  document.getElementById('providerPanels').addEventListener('click', function (e) {
    var btn = e.target;
    if (btn.tagName !== 'BUTTON') return;
    var email = btn.getAttribute('data-email');
    var action = btn.getAttribute('data-action');
    var provider = btn.getAttribute('data-provider');
    if (!email && !action && !provider) return;
    if (action === 'remove') handleRemove(email, provider);
    else if (provider) handleProviderLogin(email, provider);
  });

  /* Close modal on overlay click */
  document.getElementById('confirmOverlay').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('open');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
