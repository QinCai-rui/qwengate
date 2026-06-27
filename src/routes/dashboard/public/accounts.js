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

/* ── Per-Provider Helpers ── */
var PROV_META = {
  qwen: { label: 'Qwen', btnClass: 'q', dotClass: 'qwen-dot' },
  deepseek: { label: 'DeepSeek', btnClass: 'd', dotClass: 'deepseek-dot' },
  zai: { label: 'GLM', btnClass: 'g', dotClass: 'zai-dot' },
};

function providerStatusBadge(status) {
  var dots = {
    live: 'live',
    expired: 'expired',
    connecting: 'connecting',
    pending: 'pending',
    disconnected: 'disconnected',
    unknown: 'unknown',
  };
  var dotClass = dots[status] || 'unknown';
  var labels = { live: 'Live', expired: 'Expired', connecting: 'Connecting', pending: 'Pending', disconnected: '—', unknown: 'Unknown' };
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

function renderProviderCell(email, providerKey, auth) {
  var meta = PROV_META[providerKey];
  var status = (auth && auth.status) || 'disconnected';
  var isLive = status === 'live';
  var btn = isLive
    ? '<button class="prov-login-btn logged-in" disabled>Logged In</button>'
    : '<button class="prov-login-btn ' +
      meta.btnClass +
      '" data-email="' +
      escHtml(email) +
      '" data-provider="' +
      providerKey +
      '">Login</button>';
  return '<div class="prov-cell">' + providerStatusBadge(status) + btn + '</div>';
}

function renderAccountsTable(accts) {
  if (!Array.isArray(accts) || accts.length === 0) {
    document.getElementById('acctBody').innerHTML = '';
    document.getElementById('emptyState').style.display = '';
    setText('acctCount', '');
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  setText('acctCount', accts.length + ' total');
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    rows +=
      '<tr>' +
      '<td class="email-cell">' +
      escHtml(a.email) +
      '</td>' +
      '<td>' +
      (a.inFlight || 0) +
      '</td>' +
      '<td>' +
      (a.totalRequests || 0) +
      '</td>' +
      '<td>' +
      makeThrottleBadge(a) +
      '</td>' +
      '<td>' +
      '<span class="toggle-trigger" onclick="handleToggleDisabled(event,\'' +
      escHtml(a.email) +
      "'," +
      a.disabled +
      ')">' +
      '<span class="toggle-track' +
      (a.disabled ? ' active' : '') +
      '">' +
      '<span class="toggle-thumb"></span>' +
      '</span></span>' +
      '</td>' +
      '<td>' +
      renderProviderCell(a.email, 'qwen', a.providerAuth && a.providerAuth.qwen) +
      '</td>' +
      '<td>' +
      renderProviderCell(a.email, 'deepseek', a.providerAuth && a.providerAuth.deepseek) +
      '</td>' +
      '<td>' +
      renderProviderCell(a.email, 'zai', a.providerAuth && a.providerAuth.zai) +
      '</td>' +
      '<td><div class="action-cell">' +
      '<button class="account-btn small" data-email="' +
      escHtml(a.email) +
      '" data-action="configure">Keys</button>' +
      '<button class="account-btn small danger" data-email="' +
      escHtml(a.email) +
      '" data-action="remove">Remove</button>' +
      '</div></td></tr>';
  }
  document.getElementById('acctBody').innerHTML = rows;
}

/* ── Load Accounts ── */
async function loadAccounts() {
  var data = await apiFetch('/accounts');
  renderAccountsTable(data);
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

/* ── Remove Account ── */
function handleRemove(email) {
  document.getElementById('confirmEmail').textContent = email;
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmYes').onclick = async function () {
    document.getElementById('confirmOverlay').classList.remove('open');
    setError(null);
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
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
        throw new Error(
          result && result.error && result.error.message ? result.error.message : 'Failed to remove account (' + res.status + ')',
        );
      }
      showToast('Account removed: ' + email, 'success');
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
  zai: '/login/zai',
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

/* ── Configure Provider Keys ── */
var currentConfigEmail = null;

function handleOpenConfig(email) {
  currentConfigEmail = email;
  document.getElementById('configEmail').textContent = email;
  document.getElementById('deepseekKeyInput').value = '';
  document.getElementById('zaiKeyInput').value = '';
  document.getElementById('configOverlay').classList.add('open');
}

function handleSaveConfig() {
  var deepseekKey = document.getElementById('deepseekKeyInput').value.trim();
  var zaiKey = document.getElementById('zaiKeyInput').value.trim();
  if (!deepseekKey && !zaiKey) {
    showToast('Enter at least one API key', 'error');
    return;
  }
  var body = {
    providerKeys: {},
  };
  if (deepseekKey) body.providerKeys.deepseek = deepseekKey;
  if (zaiKey) body.providerKeys.zai = zaiKey;

  document.getElementById('configSave').disabled = true;
  document.getElementById('configSave').textContent = 'Saving...';

  (async function () {
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(currentConfigEmail), {
        method: 'PATCH',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to save keys (' + res.status + ')');
      showToast('Provider keys saved for ' + currentConfigEmail, 'success');
      document.getElementById('configOverlay').classList.remove('open');
      loadAccounts();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      document.getElementById('configSave').disabled = false;
      document.getElementById('configSave').textContent = 'Save Keys';
    }
  })();
}

/* ── Init ── */
function init() {
  /* Load on start */
  loadAccounts();

  /* Auto-poll every 2 seconds */
  createPoller(loadAccounts, 2000);

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
  document.getElementById('acctTable').addEventListener('click', function (e) {
    var btn = e.target;
    if (btn.tagName !== 'BUTTON') return;
    var email = btn.getAttribute('data-email');
    var action = btn.getAttribute('data-action');
    var provider = btn.getAttribute('data-provider');
    if (!email && !action && !provider) return;
    if (action === 'remove') handleRemove(email);
    else if (action === 'configure') handleOpenConfig(email);
    else if (provider) handleProviderLogin(email, provider);
  });

  /* Close modal on overlay click */
  document.getElementById('confirmOverlay').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('open');
  });
  document.getElementById('configOverlay').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('open');
  });

  /* Config modal */
  document.getElementById('configCancel').addEventListener('click', function () {
    document.getElementById('configOverlay').classList.remove('open');
  });
  document.getElementById('configSave').addEventListener('click', handleSaveConfig);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
