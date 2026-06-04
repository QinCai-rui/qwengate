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
async function apiFetch(url) {
  try {
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}
var API_KEY = window.API_KEY || '';
var APP_VERSION = window.APP_VERSION || '0.2.0';

/* ── Update check ── */
(function checkUpdate() {
  var bannerId = 'update-banner';
  if (document.getElementById(bannerId)) return;
  fetch('https://api.github.com/repos/youssefvdel/qwen-gate/releases/latest', { signal: AbortSignal.timeout(5000) })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var latest = (data.tag_name || '').replace(/^v/, '');
      if (!latest || latest === APP_VERSION) return;
      var banner = document.createElement('div');
      banner.id = bannerId;
      banner.style.cssText = 'background:var(--accent);color:#fff;text-align:center;padding:8px 16px;font-size:0.8rem;font-weight:500;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap';
      banner.innerHTML = 'Update available: v' + APP_VERSION + ' → v' + latest
        + ' <code style="background:rgba(255,255,255,0.2);padding:3px 8px;border-radius:4px;font-size:0.7rem">qg update</code>'
        + ' <button onclick="this.parentElement.remove()" style="background:none;border:1px solid rgba(255,255,255,0.4);color:#fff;border-radius:4px;padding:2px 10px;cursor:pointer;font-size:0.7rem;margin-left:4px">Dismiss</button>';
      var main = document.querySelector('.main-content') || document.body;
      main.parentElement.insertBefore(banner, main);
    })
    .catch(function() {});
})();