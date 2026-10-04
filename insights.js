// insights.js — local focus report.
//
// Reads the per-day buckets the content script accumulates. The one rule that
// shapes this whole page: focus is reported as a share of *measured* time, never
// of watched time. Attention is only knowable while the camera is running, so
// claiming a focus percentage for time the detector was off would be inventing
// data. When nothing was measured, the page says so instead of showing 0%.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

const MIN = 60000;
const HOUR = 3600000;

function dur(ms) {
  const m = Math.round((Number(ms) || 0) / MIN);
  if (m < 1) return Math.max(0, Math.round((Number(ms) || 0) / 1000)) + 's';
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

function labelFor(key, todayKey) {
  if (key === todayKey) return 'Today';
  const d = new Date(key + 'T12:00:00');
  const y = new Date(todayKey + 'T12:00:00');
  if (Math.round((y - d) / 86400000) === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

const blank = () => ({ watchedMs: 0, measuredMs: 0, focusedMs: 0, awayMs: 0, hyperFocusMs: 0, pauses: {} });

function sum(days) {
  const t = blank();
  t.pauses = { face: 0, cursor: 0, fullscreen: 0 };
  for (const d of days) {
    t.watchedMs += d.watchedMs || 0;
    t.measuredMs += d.measuredMs || 0;
    t.focusedMs += d.focusedMs || 0;
    t.awayMs += d.awayMs || 0;
    t.hyperFocusMs += d.hyperFocusMs || 0;
    for (const k of ['face', 'cursor', 'fullscreen']) t.pauses[k] += (d.pauses && d.pauses[k]) || 0;
  }
  return t;
}

function renderHeadline(day) {
  $('watched').textContent = dur(day.watchedMs);
  $('focused').textContent = dur(day.focusedMs);
  $('hyper').textContent = dur(day.hyperFocusMs);

  const p = pct(day.focusedMs, day.measuredMs);
  const ring = $('ring');
  const pctEl = $('pctVal');
  const sub = $('pctSub');

  if (p === null) {
    ring.style.setProperty('--p', '0');
    pctEl.textContent = '--';
    sub.textContent = day.watchedMs > 0
      ? 'Camera was off, so attention was not measured'
      : 'Nothing watched yet today';
    return;
  }
  ring.style.setProperty('--p', String(p));
  pctEl.textContent = p + '%';
  sub.textContent = 'of ' + dur(day.measuredMs) + ' measured';
  ring.classList.toggle('good', p >= 75);
  ring.classList.toggle('mid', p >= 45 && p < 75);
  ring.classList.toggle('low', p < 45);
}

function renderBreakdown(day) {
  const rows = [
    ['Looked away', day.pauses.face || 0, 'The camera stopped the video'],
    ['Reached for the mouse', day.pauses.cursor || 0, 'Cursor Pause stopped the video'],
    ['Left fullscreen', day.pauses.fullscreen || 0, 'Auto Fullscreen stopped the video']
  ];
  const total = rows.reduce((a, r) => a + r[1], 0);
  $('interruptTotal').textContent = total === 1 ? '1 interruption' : total + ' interruptions';

  const host = $('breakdown');
  host.innerHTML = '';
  if (!total) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No interruptions recorded today.';
    host.appendChild(p);
    return;
  }
  for (const [name, n, why] of rows) {
    const row = document.createElement('div');
    row.className = 'brow';
    const share = total ? Math.round((n / total) * 100) : 0;
    row.innerHTML =
      '<div class="brow-top"><span class="brow-name"></span><span class="brow-n"></span></div>' +
      '<div class="brow-bar"><i style="width:' + share + '%"></i></div>' +
      '<p class="brow-why"></p>';
    row.querySelector('.brow-name').textContent = name;
    row.querySelector('.brow-n').textContent = n === 1 ? '1 time' : n + ' times';
    row.querySelector('.brow-why').textContent = why;
    host.appendChild(row);
  }
}

function renderWeek(days, todayKey) {
  const host = $('week');
  host.innerHTML = '';
  const keys = [];
  const base = new Date(todayKey + 'T12:00:00');
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    keys.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  const peak = Math.max(1, ...keys.map((k) => (days[k] || blank()).watchedMs));

  for (const k of keys) {
    const d = { ...blank(), ...(days[k] || {}) };
    const col = document.createElement('div');
    col.className = 'day' + (k === todayKey ? ' is-today' : '');
    const focusH = Math.round((d.focusedMs / peak) * 100);
    const watchH = Math.round((d.watchedMs / peak) * 100);
    col.innerHTML =
      '<div class="stack" title="">' +
        '<div class="watch" style="height:' + watchH + '%"></div>' +
        '<div class="focus" style="height:' + focusH + '%"></div>' +
      '</div>' +
      '<span class="dlabel"></span>';
    col.querySelector('.stack').title =
      labelFor(k, todayKey) + ': ' + dur(d.watchedMs) + ' watched, ' + dur(d.focusedMs) + ' focused';
    col.querySelector('.dlabel').textContent = labelFor(k, todayKey).slice(0, 3);
    host.appendChild(col);
  }
}

function renderTotals(days, keepDays) {
  const all = sum(Object.values(days).map((d) => ({ ...blank(), ...d, pauses: d.pauses || {} })));
  $('allWatched').textContent = dur(all.watchedMs);
  $('allFocused').textContent = dur(all.focusedMs);
  const p = pct(all.focusedMs, all.measuredMs);
  $('allPct').textContent = p === null ? '--' : p + '%';
  $('allDays').textContent = Object.keys(days).length + ' day(s) recorded, keeping the last ' + keepDays;
}

async function load() {
  const res = await send({ t: 'getStats' });
  if (!res || !res.ok) { $('pctSub').textContent = 'Could not read your history.'; return; }
  const days = res.days || {};
  const today = { ...blank(), ...(days[res.today] || {}) };
  today.pauses = today.pauses || {};

  renderHeadline(today);
  renderBreakdown(today);
  renderWeek(days, res.today);
  renderTotals(days, res.keepDays || 60);

  const st = await send({ t: 'getStatus' });
  const on = st && st.settings && st.settings.statsEnabled;
  $('recording').textContent = on ? 'Recording locally' : 'Recording is off';
  $('recording').className = 'badge' + (on ? ' on' : '');
}

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Delete all recorded focus history? This cannot be undone.')) return;
  await send({ t: 'clearStats' });
  load();
});

load();
