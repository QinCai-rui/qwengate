/* ── Usage Page ── */

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtNum(n) {
  return (n == null ? 0 : n).toLocaleString('en-US');
}

function fmtWait(hours) {
  if (hours == null) return '—';
  if (hours <= 0) return 'unlocked';
  return hours + 'h';
}

function renderKpis(accounts) {
  var totalToday = 0;
  var totalWeek = 0;
  var walls = 0;
  var walledModels = {};
  Object.keys(accounts || {}).forEach(function (email) {
    var a = accounts[email];
    totalToday += a.today || 0;
    totalWeek += a.week || 0;
    Object.keys(a.models || {}).forEach(function (m) {
      var e = a.models[m];
      if (e.rateLimited > 0) {
        walls += e.rateLimited;
        walledModels[m] = e;
      }
    });
  });
  setText('kpiToday', fmtNum(totalToday));
  setText('kpiTodaySub', totalToday === 1 ? '1 request today' : totalToday + ' requests today');
  setText('kpiWeek', fmtNum(totalWeek));
  setText('kpiWeekSub', 'across all accounts');
  setText('kpiAccounts', fmtNum(Object.keys(accounts || {}).length));
  setText('kpiAccountsSub', 'accounts with activity');
  setText('kpiWalls', fmtNum(walls));
  var wallModels = Object.keys(walledModels);
  setText('kpiWallsSub', wallModels.length ? 'models: ' + wallModels.join(', ') : 'no walls hit');
}

function renderAccountRows(accounts) {
  var emails = Object.keys(accounts || {});
  if (emails.length === 0) {
    document.getElementById('emptyState').style.display = 'block';
    document.getElementById('usageBody').innerHTML = '';
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  var rows = emails
    .sort(function (a, b) {
      return (accounts[b].today || 0) - (accounts[a].today || 0);
    })
    .map(function (email) {
      var a = accounts[email];
      var models = Object.keys(a.models || {}).sort(function (x, y) {
        return (a.models[y].requests || 0) - (a.models[x].requests || 0);
      });
      var chips = models
        .map(function (m) {
          var e = a.models[m];
          var cls = e.rateLimited > 0 ? 'model-chip walled' : 'model-chip';
          var warn =
            e.rateLimited > 0
              ? '<span class="chip-warn" title="' + e.rateLimited + ' rate-limit wall(s)">⚠' + e.rateLimited + '</span>'
              : '';
          return '<span class="' + cls + '">' + escHtml(m) + ' <b>' + fmtNum(e.requests) + '</b>' + warn + '</span>';
        })
        .join('');
      return (
        '<tr>' +
        '<td><span class="acct-email">' +
        escHtml(email) +
        '</span></td>' +
        '<td class="num">' +
        fmtNum(a.today) +
        '</td>' +
        '<td class="num">' +
        fmtNum(a.yesterday) +
        '</td>' +
        '<td class="num">' +
        fmtNum(a.week) +
        '</td>' +
        '<td><div class="model-split">' +
        (chips || '<span class="acct-sub">no requests</span>') +
        '</div></td>' +
        '</tr>'
      );
    })
    .join('');
  document.getElementById('usageBody').innerHTML = rows;
}

function renderModelRows(accounts) {
  var totals = {};
  Object.keys(accounts || {}).forEach(function (email) {
    Object.keys(accounts[email].models || {}).forEach(function (m) {
      var e = accounts[email].models[m];
      var t = totals[m] || (totals[m] = { requests: 0, rateLimited: 0, lastWaitHours: null });
      t.requests += e.requests || 0;
      t.rateLimited += e.rateLimited || 0;
      if (e.lastWaitHours != null) t.lastWaitHours = e.lastWaitHours;
    });
  });
  var models = Object.keys(totals).sort(function (a, b) {
    return totals[b].requests - totals[a].requests;
  });
  var rows = models
    .map(function (m) {
      var t = totals[m];
      var wallBadge =
        t.rateLimited > 0
          ? '<span class="badge badge-danger">⚠ ' + t.rateLimited + '</span>'
          : '<span class="badge badge-neutral">0</span>';
      return (
        '<tr>' +
        '<td><span class="acct-email">' +
        escHtml(m) +
        '</span></td>' +
        '<td class="num">' +
        fmtNum(t.requests) +
        '</td>' +
        '<td class="num">' +
        wallBadge +
        '</td>' +
        '<td>' +
        fmtWait(t.lastWaitHours) +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
  document.getElementById('modelBody').innerHTML = rows || '<tr><td colspan="4" class="empty-state">No data yet.</td></tr>';
}

async function loadUsage() {
  var data = await apiFetch('/api/usage');
  if (!data || !data.accounts) return;
  renderKpis(data.accounts);
  renderAccountRows(data.accounts);
  renderModelRows(data.accounts);
}

loadUsage();
setInterval(loadUsage, 15000);
