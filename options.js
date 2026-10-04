// options.js — allowlist / blocklist editor.
//
// The service worker owns settings, so this writes through it rather than poking
// storage directly. That keeps validation in exactly one place: whatever the user
// types here goes through the same cleanList() every other surface uses.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

const els = {
  allow: $('allow'),
  block: $('block'),
  allowCount: $('allowCount'),
  blockCount: $('blockCount'),
  save: $('save'),
  status: $('status')
};

const toText = (list) => (Array.isArray(list) ? list.join('\n') : '');
const toList = (text) => String(text || '').split(/[\s,]+/).filter(Boolean);

function describe(list, kind) {
  const n = list.length;
  if (!n) return kind === 'allow'
    ? 'Empty: while Hyper Focus is on, only your chosen video is reachable.'
    : 'Empty: nothing is permanently blocked.';
  return n === 1 ? '1 domain' : n + ' domains';
}

function refreshCounts() {
  els.allowCount.textContent = describe(toList(els.allow.value), 'allow');
  els.blockCount.textContent = describe(toList(els.block.value), 'block');
}

async function load() {
  const st = await send({ t: 'getStatus' });
  const s = (st && st.settings) || {};
  els.allow.value = toText(s.hfAllowlist);
  els.block.value = toText(s.hfBlocklist);
  refreshCounts();
}

function flash(text, bad) {
  els.status.textContent = text;
  els.status.className = 'status show' + (bad ? ' bad' : '');
  setTimeout(() => { els.status.className = 'status'; }, 2400);
}

els.allow.addEventListener('input', refreshCounts);
els.block.addEventListener('input', refreshCounts);

els.save.addEventListener('click', async () => {
  els.save.disabled = true;
  const res = await send({
    t: 'setSettings',
    patch: { hfAllowlist: toList(els.allow.value), hfBlocklist: toList(els.block.value) }
  });
  els.save.disabled = false;

  if (!res || !res.ok) { flash('Could not save. Try reopening this page.', true); return; }

  // Show the cleaned lists back, so anything dropped or rewritten is visible
  // instead of silently disagreeing with what is stored.
  const s = res.settings || {};
  const before = toList(els.allow.value).length + toList(els.block.value).length;
  els.allow.value = toText(s.hfAllowlist);
  els.block.value = toText(s.hfBlocklist);
  refreshCounts();
  const after = (s.hfAllowlist || []).length + (s.hfBlocklist || []).length;
  flash(before === after ? 'Saved.' : `Saved. ${before - after} entr${before - after === 1 ? 'y' : 'ies'} cleaned up or duplicated.`);
});

load();
