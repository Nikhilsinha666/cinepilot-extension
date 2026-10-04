// background.js — CinePilot for YouTube (service worker / orchestrator)
//
// Merges two former extensions into one brain:
//   * Auto Fullscreen  — content-script only, background just owns the setting.
//   * Face Pause       — needs a camera + inference, so the background decides
//                        WHERE detection runs and relays the away/looking state.
//
// Detector arbitration (the important part):
//   Exactly one detector may run at a time, otherwise we would open the camera
//   twice and pay for MediaPipe inference twice.
//     - If any tab has the on-page camera preview (PiP) open, that page is the
//       detector and the offscreen document is shut down.
//     - Otherwise the hidden offscreen document is the detector. It keeps
//       working while YouTube is fullscreen, which the in-page path cannot
//       guarantee, so it is the preferred source.
//     - If the offscreen document cannot open the camera, we flip `fallback`
//       on and ask the pages to run the in-page detector instead.
//
// Everything is on-device. No network calls anywhere in this extension.

const OFFSCREEN_PATH = 'offscreen.html';
const PERMISSION_PATH = 'permission.html';
const YT_URL_MATCH = '*://*.youtube.com/*';
// 3 added the idle-based cursor pause; 4 replaced it with interaction-based
// Cursor Pause and added Hyper Focus.
const SCHEMA_VERSION = 4;

const DEFAULT_SETTINGS = {
  // Master kill switch for both features.
  masterEnabled: true,

  // ---- Face Pause ----
  fpEnabled: true,
  fpMode: 'head',        // 'head' | 'eyes'
  fpSensitivity: 3,      // 1 (lenient) .. 5 (strict)
  fpPauseDelayMs: 90,    // near-instant pause
  fpResumeDelayMs: 220,  // small delay so a blink/glance does not flicker
  fpRewindSec: 2,        // on resume, step back this many seconds (0 = off)
  fpFocusOnly: true,     // release the camera unless YouTube is in front
  fpShowPip: false,      // floating camera preview on the page
  fpShowIndicator: true, // small status pill on the page

  // ---- Auto Fullscreen ----
  afEnabled: true,
  afDelayMs: 500,        // wait before clicking YouTube's fullscreen button
  afPauseOnExit: true,   // pause the video when you leave fullscreen
  afRefocus: true,       // re-enter fullscreen when you come back to the tab

  // ---- Cursor Pause ----
  // Pauses the moment you touch the mouse, because reaching for the mouse is
  // the moment your attention left the video. You resume it yourself; there is
  // deliberately no auto-resume, since the movement is the trigger.
  curEnabled: false,
  curSensitivityPx: 60,  // movement inside one burst that counts as intent
  curGraceMs: 1500,      // ignore the mouse for this long after playback starts
  curOnClick: true,      // clicks and scrolling pause immediately
  curToast: true,        // announce the pause on the page
  curAutoResume: true,   // resume once the mouse goes still again
  curResumeAfterMs: 2000, // how long the mouse must be still first

  // ---- Hyper Focus ----
  hfEnabled: false,
  hfHideDistractions: true, // strip the page down to the player
  hfMinutes: 0,             // session length, 0 = no limit
  hfLockPercent: 0,         // cannot switch off until this much is watched, 0 = off
  hfShowBar: true,          // one-click button in the player controls
  hfAllowlist: [],          // exempt from Hyper Focus blocking
  hfBlocklist: [],          // blocked at all times, Hyper Focus or not

  // ---- Insights ----
  statsEnabled: true        // record focus time locally
};

// ------------------------------------------------------------------ stats ---
// Everything here stays on this machine. The camera already knows whether you
// are looking at the screen, so turning that into "how much did I actually
// watch attentively today" costs nothing extra and never leaves the device.

const STATS_KEEP_DAYS = 60;

const dayKey = (d) => {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

const emptyDay = () => ({
  watchedMs: 0,   // video actually playing
  measuredMs: 0,  // playing while the detector could see you
  focusedMs: 0,   // measured and looking at the screen
  awayMs: 0,      // measured and not looking
  hyperFocusMs: 0,
  pauses: { face: 0, cursor: 0, fullscreen: 0 }
});

const posInt = (n) => {
  const v = Math.round(Number(n) || 0);
  return v > 0 && v < 24 * 3600 * 1000 ? v : 0; // a delta bigger than a day is nonsense
};

async function readStats() {
  try {
    const s = await chrome.storage.local.get('stats');
    const stats = s.stats && typeof s.stats === 'object' ? s.stats : {};
    if (!stats.days || typeof stats.days !== 'object') stats.days = {};
    return stats;
  } catch (_) {
    return { days: {} };
  }
}

function pruneStats(stats) {
  const keys = Object.keys(stats.days).sort();
  while (keys.length > STATS_KEEP_DAYS) delete stats.days[keys.shift()];
}

async function addStats(delta) {
  if (!runtime.settings.statsEnabled || !delta) return;
  const stats = await readStats();
  const key = dayKey();
  const day = { ...emptyDay(), ...(stats.days[key] || {}) };
  day.pauses = { ...emptyDay().pauses, ...(day.pauses || {}) };

  day.watchedMs += posInt(delta.watchedMs);
  day.measuredMs += posInt(delta.measuredMs);
  day.focusedMs += posInt(delta.focusedMs);
  day.awayMs += posInt(delta.awayMs);
  day.hyperFocusMs += posInt(delta.hyperFocusMs);
  for (const k of ['face', 'cursor', 'fullscreen']) {
    day.pauses[k] += posInt(delta.pauses && delta.pauses[k]);
  }

  stats.days[key] = day;
  pruneStats(stats);
  try { await chrome.storage.local.set({ stats }); } catch (_) {}
}

const runtime = {
  settings: { ...DEFAULT_SETTINGS },

  activeTabs: new Set(),  // YouTube tabs with a live video session
  engagedTabs: new Set(), // subset of those that are visible AND focused
  pipTabs: new Set(),     // tabs currently running the in-page detector

  cameraRunning: false,
  suspended: false,       // camera released because nothing is in front
  offscreenReady: false,
  offscreenStarting: false,

  away: false,
  faceDetected: false,
  calibrating: false,
  metrics: { yaw: 0, pitch: 0 },

  source: 'none',        // 'offscreen' | 'page' | 'none'
  fallback: false,       // offscreen failed -> pages must detect locally
  fallbackAt: 0,         // when that happened, so we can retry later
  lastError: null,
  needPermission: false,
  permissionTabOpenedAt: 0,

  // ---- Hyper Focus ----
  hfTabId: null,   // the tab allowed to keep playing
  hfUrl: '',       // the exact video URL it was armed on
  hfVideoId: '',   // parsed watch id, so seeking/param noise does not break out
  hfBlocked: 0,    // how many navigations we have turned away this session
  hfEndsAt: 0,     // epoch ms the timed session ends, 0 = no limit
  hfStartedAt: 0,  // for crediting hyperFocusMs on disarm

  // Watch progress for the commitment lock, reported by the focused tab.
  hfProgress: { videoId: '', playedMs: 0, maxPosMs: 0, durationMs: 0, ended: false, at: 0 }
};

// If the focused tab stops reporting for this long we can no longer prove the
// lock is unmet, so it is released. A dead content script must never be able to
// leave someone with a locked browser.
const PROGRESS_STALE_MS = 60000;

// How long to stay in fallback before giving the hidden detector another go.
const FALLBACK_RETRY_MS = 60000;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// ---------------------------------------------------------------- settings ---

// Accepts either the new namespaced schema or the two legacy ones and returns a
// complete settings object. Legacy "Face Pause" kept {enabled, mode,
// sensitivity, ...} in storage.local; legacy "Auto Fullscreen" kept {enabled}
// in storage.sync.
function normalizeSettings(stored, legacySync) {
  const out = { ...DEFAULT_SETTINGS };
  const s = stored && typeof stored === 'object' ? stored : {};

  // --- legacy Face Pause keys ---
  if (typeof s.enabled === 'boolean') out.fpEnabled = s.enabled;
  if (s.mode === 'eyes' || s.mode === 'head') out.fpMode = s.mode;
  if (isNum(s.sensitivity)) out.fpSensitivity = clamp(Math.round(s.sensitivity), 1, 5);
  if (isNum(s.pauseDelayMs)) out.fpPauseDelayMs = clamp(s.pauseDelayMs, 0, 3000);
  if (isNum(s.resumeDelayMs)) out.fpResumeDelayMs = clamp(s.resumeDelayMs, 0, 3000);
  if (typeof s.showIndicator === 'boolean') out.fpShowIndicator = s.showIndicator;

  // --- legacy storage.sync keys ---
  // Both old extensions wrote a key literally called `enabled` here, so which
  // one it came from is unknowable; we map it to Auto Fullscreen. `delay` was
  // only ever written by the cursor-pause extension, so that one is safe.
  if (legacySync && typeof legacySync.enabled === 'boolean') out.afEnabled = legacySync.enabled;

  // --- schema 3 keys (the idle-based cursor pause this replaced) ---
  // Only the on/off choice and the toast preference carry over. The old `idleMs`
  // was a delay before pausing on *inactivity*, which has no meaning now that
  // activity is the trigger, so it is dropped rather than mistranslated.
  if (typeof s.idleEnabled === 'boolean') out.curEnabled = s.idleEnabled;
  if (typeof s.idleToast === 'boolean') out.curToast = s.idleToast;

  // --- current schema wins over anything inferred above ---
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in s) out[key] = s[key];
  }

  // --- validate ---
  out.fpMode = out.fpMode === 'eyes' ? 'eyes' : 'head';
  out.fpSensitivity = clamp(Math.round(Number(out.fpSensitivity) || 3), 1, 5);
  out.fpPauseDelayMs = clamp(Number(out.fpPauseDelayMs) || 0, 0, 3000);
  out.fpResumeDelayMs = clamp(Number(out.fpResumeDelayMs) || 0, 0, 3000);
  // half-second granularity, 0 disables the rewind
  out.fpRewindSec = clamp(Math.round((Number(out.fpRewindSec) || 0) * 2) / 2, 0, 10);
  out.afDelayMs = clamp(Number(out.afDelayMs) || 0, 0, 3000);
  out.curSensitivityPx = clamp(Math.round(Number(out.curSensitivityPx) || 60), 5, 400);
  out.curGraceMs = clamp(Math.round((Number(out.curGraceMs) || 0) / 100) * 100, 0, 6000);
  out.curResumeAfterMs = clamp(Math.round((Number(out.curResumeAfterMs) || 2000) / 250) * 250, 250, 15000);
  out.hfMinutes = clamp(Math.round(Number(out.hfMinutes) || 0), 0, 240);
  out.hfLockPercent = clamp(Math.round((Number(out.hfLockPercent) || 0) / 5) * 5, 0, 100);
  out.hfAllowlist = cleanList(out.hfAllowlist);
  out.hfBlocklist = cleanList(out.hfBlocklist);
  for (const b of ['masterEnabled', 'fpEnabled', 'fpFocusOnly', 'fpShowPip', 'fpShowIndicator',
                   'afEnabled', 'afPauseOnExit', 'afRefocus',
                   'curEnabled', 'curOnClick', 'curToast', 'curAutoResume',
                   'hfEnabled', 'hfHideDistractions', 'hfShowBar', 'statsEnabled']) {
    out[b] = !!out[b];
  }
  return out;
}

// Domain/pattern lists arrive from a textarea, so they need scrubbing.
function cleanList(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,]+/);
  const out = [];
  for (const item of raw) {
    const s = String(item).trim().toLowerCase()
      .replace(/^[a-z]+:\/\//, '')  // strip scheme
      .replace(/^www\./, '')
      .replace(/\/.*$/, '')         // host only
      .replace(/[^a-z0-9.\-*]/g, '');
    // A hostname needs a dot. This also quietly discards paste accidents like
    // `javascript:alert(1)`, which would otherwise survive as junk that can
    // never match anything.
    if (!s.includes('.')) continue;
    if (s && s.length <= 253 && !out.includes(s)) out.push(s);
    if (out.length >= 300) break;
  }
  return out;
}

async function loadSettings() {
  let stored = {};
  let legacySync;
  try {
    const local = await chrome.storage.local.get(['settings', 'schema']);
    stored = local.settings || {};
    if (!(local.schema >= SCHEMA_VERSION)) {
      // First run on this build: pull whatever the old extensions left behind.
      try { legacySync = await chrome.storage.sync.get(['enabled', 'delay']); } catch (_) {}
    }
  } catch (_) {}

  runtime.settings = normalizeSettings(stored, legacySync);
  try {
    await chrome.storage.local.set({ settings: runtime.settings, schema: SCHEMA_VERSION });
  } catch (_) {}
  updateBadge();
  return runtime.settings;
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ settings: runtime.settings, schema: SCHEMA_VERSION });
  } catch (_) {}
}

// Config shape the AttentionEngine understands.
function engineConfig() {
  const s = runtime.settings;
  return {
    mode: s.fpMode,
    sensitivity: s.fpSensitivity,
    pauseDelayMs: s.fpPauseDelayMs,
    resumeDelayMs: s.fpResumeDelayMs
  };
}

const facePauseWanted = () => runtime.settings.masterEnabled && runtime.settings.fpEnabled;

// ------------------------------------------------------- offscreen document ---

async function hasOffscreen() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) return await chrome.offscreen.hasDocument();
  } catch (_) {}
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return !!(contexts && contexts.length);
  } catch (_) {}
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (runtime.offscreenStarting) return;
  runtime.offscreenStarting = true;
  runtime.offscreenReady = false;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Use the webcam locally to detect whether you are looking at the video.'
    });
  } catch (e) {
    // Losing a create race is fine; anything else is worth reporting.
    if (!String((e && e.message) || e).includes('Only a single offscreen')) {
      runtime.lastError = String((e && e.message) || e);
    }
  } finally {
    runtime.offscreenStarting = false;
  }
}

function waitForOffscreenReady(timeoutMs = 4000) {
  if (runtime.offscreenReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (runtime.offscreenReady) { clearInterval(iv); resolve(true); }
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 50);
  });
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, _to: 'offscreen' }).catch(() => {});
}

async function startOffscreenCamera() {
  await ensureOffscreen();
  const ready = await waitForOffscreenReady();
  if (!ready) {
    runtime.lastError = 'The detector did not start. Try reloading the extension.';
    runtime.cameraRunning = false;
    return;
  }
  await sendToOffscreen({ t: 'config', settings: engineConfig() });
  await sendToOffscreen({ t: 'start' });
}

async function stopOffscreenCamera() {
  if (await hasOffscreen()) {
    await sendToOffscreen({ t: 'stop' });
    try { await chrome.offscreen.closeDocument(); } catch (_) {}
  }
  runtime.cameraRunning = false;
  runtime.offscreenReady = false;
}

// Release the camera device (so the recording light goes out) but keep the
// document alive, because reloading the 22MB WASM runtime and the face model on
// every tab switch would be absurd.
async function suspendOffscreenCamera() {
  if (await hasOffscreen()) await sendToOffscreen({ t: 'stop' });
  runtime.cameraRunning = false;
}

// Offscreen documents cannot show a permission prompt, so send the user to a
// real page that can. Throttled so we never spam tabs.
// ============================================================ Hyper Focus ===
//
// Blocking works by redirecting offending tabs to our own blocked.html. That
// deliberately avoids declarativeNetRequest and the broad host permissions it
// would need -- this is a self-discipline tool, not a security boundary, and it
// is not worth asking for read-access to every site you visit to build it.
//
// Two lists, two different jobs:
//   blocklist  blocks always, Hyper Focus on or off (permanent distractions)
//   allowlist  stays reachable while Hyper Focus is on (docs, notes, whatever)

const BLOCKED_PATH = 'blocked.html';

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

function videoIdOf(url) {
  try {
    const u = new URL(url);
    if (u.pathname === '/watch') return u.searchParams.get('v') || '';
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

// A pattern matches the host itself or any subdomain. `*.foo.com` and `foo.com`
// behave the same, which is what people actually expect from these lists.
function listMatches(host, list) {
  if (!host || !Array.isArray(list)) return false;
  for (const raw of list) {
    const p = String(raw).replace(/^\*\./, '');
    if (!p) continue;
    if (host === p || host.endsWith('.' + p)) return true;
  }
  return false;
}

// Anything that is not a normal web page is always left alone, so the user can
// always reach chrome://extensions to turn this off. Never trap them.
function isExempt(url) {
  return !url || !/^https?:\/\//i.test(url);
}

function blockReason(tabId, url) {
  if (isExempt(url)) return null;
  const s = runtime.settings;
  const host = hostOf(url);

  // The blocklist is independent of Hyper Focus and of its timer. Checking it
  // first matters: an expired session must not quietly unblock the sites you
  // asked to have blocked permanently.
  if (listMatches(host, s.hfBlocklist)) return 'blocklist';

  if (!s.masterEnabled || !s.hfEnabled) return null;
  // A finished session must stop blocking even if the tab that was supposed to
  // report the expiry has gone away.
  if (hyperFocusExpired()) return null;
  if (listMatches(host, s.hfAllowlist)) return null;

  // The focused tab may stay on its own video.
  if (tabId != null && tabId === runtime.hfTabId) {
    const id = videoIdOf(url);
    if (runtime.hfVideoId && id === runtime.hfVideoId) return null;
    if (!runtime.hfVideoId && url === runtime.hfUrl) return null;
    return 'left-video';
  }
  return 'hyperfocus';
}

async function enforce(tabId, url) {
  const reason = blockReason(tabId, url);
  if (!reason) return false;
  runtime.hfBlocked++;
  const target = chrome.runtime.getURL(BLOCKED_PATH)
    + '?r=' + encodeURIComponent(reason)
    + '&u=' + encodeURIComponent(url);
  try { await chrome.tabs.update(tabId, { url: target }); } catch (_) {}
  return true;
}

async function sweepTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (t.id != null && t.url) await enforce(t.id, t.url);
  } catch (_) {}
}

// ---- the commitment lock ----
//
// "I should not be able to switch this off until I have actually watched 90% of
// the video." Progress is measured as media time genuinely played, not as the
// position of the scrubber, so dragging to the end proves nothing. Reaching the
// required position is ALSO required, so looping the first minute proves nothing
// either.
//
// Everything here is written so that it can fail open. A lock that can strand
// someone with a fully blocked browser is a bug, not a feature, so every case
// where progress cannot be proven releases the lock rather than holding it:
//   * no lock percentage configured
//   * the video has no finite duration (live streams)
//   * the video ended
//   * the reporting tab went quiet (crashed, or the script was torn out)
//   * the tab was closed, or the master switch went off
function lockState() {
  const need = runtime.settings.hfLockPercent;
  const p = runtime.hfProgress;
  const out = { need, locked: false, percent: 100, playedPercent: 100, reachedPercent: 100, reason: 'none' };
  if (!need || !runtime.settings.hfEnabled) return out;

  if (!p || !p.durationMs || !Number.isFinite(p.durationMs)) {
    out.reason = 'unknown-duration';
    return out;
  }
  if (p.ended) { out.reason = 'ended'; return out; }
  if (!p.at || Date.now() - p.at > PROGRESS_STALE_MS) { out.reason = 'stale'; return out; }

  const played = Math.min(100, (p.playedMs / p.durationMs) * 100);
  const reached = Math.min(100, (p.maxPosMs / p.durationMs) * 100);
  out.playedPercent = Math.floor(played);
  out.reachedPercent = Math.floor(reached);
  out.percent = Math.floor(Math.min(played, reached));
  out.locked = out.percent < need;
  out.reason = out.locked ? 'locked' : 'satisfied';
  return out;
}

// Reasons that always release, because they are escapes of last resort rather
// than the user changing their mind mid-video.
const FORCE_RELEASE = new Set(['tab-closed', 'master-off', 'video-ended']);

// The countdown is driven by the focused tab rather than chrome.alarms, so the
// extension does not have to request another permission for a feature that only
// matters while a YouTube tab is open anyway. The tab reports expiry; this is the
// backstop that catches it whenever anything else asks us a question.
function hyperFocusExpired() {
  if (!(runtime.settings.hfEnabled && runtime.hfEndsAt > 0 && Date.now() >= runtime.hfEndsAt)) return false;
  // The lock outranks the timer, otherwise setting a one-minute session would be
  // a trivial way around a commitment you deliberately made.
  return !lockState().locked;
}

async function checkHyperFocusTimer() {
  if (hyperFocusExpired()) await disarmHyperFocus('timer');
}

async function armHyperFocus(minutes) {
  // Arm on the active tab if it is a video, otherwise on any tab that has one.
  let tab = null;
  try {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && active[0] && videoIdOf(active[0].url || '')) tab = active[0];
    if (!tab) {
      const yt = await chrome.tabs.query({ url: YT_URL_MATCH });
      tab = (yt || []).find((t) => videoIdOf(t.url || '')) || null;
    }
  } catch (_) {}

  if (!tab) return { ok: false, error: 'Open a YouTube video first, then turn on Hyper Focus.' };

  const mins = minutes === undefined || minutes === null
    ? runtime.settings.hfMinutes
    : clamp(Math.round(Number(minutes) || 0), 0, 240);

  runtime.hfTabId = tab.id;
  runtime.hfUrl = tab.url || '';
  runtime.hfVideoId = videoIdOf(runtime.hfUrl);
  runtime.hfStartedAt = Date.now();
  runtime.hfEndsAt = mins > 0 ? Date.now() + mins * 60000 : 0;
  runtime.hfBlocked = 0;
  // Progress starts from zero for this session, so a video you had already been
  // watching does not arrive pre-unlocked.
  runtime.hfProgress = { videoId: runtime.hfVideoId, playedMs: 0, maxPosMs: 0, durationMs: 0, ended: false, at: 0 };

  await applySettingsPatch({ hfEnabled: true, hfMinutes: mins });
  await sweepTabs();
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
  return { ok: true, tabId: tab.id, endsAt: runtime.hfEndsAt };
}

async function disarmHyperFocus(reason) {
  const lock = lockState();
  if (lock.locked && !FORCE_RELEASE.has(reason)) {
    return {
      ok: false,
      locked: true,
      percent: lock.percent,
      need: lock.need,
      error: `You committed to watching ${lock.need}% first. You are at ${lock.percent}%.`
    };
  }

  // Credit the time spent before tearing the session down.
  if (runtime.hfStartedAt) {
    await addStats({ hyperFocusMs: Date.now() - runtime.hfStartedAt });
    runtime.hfStartedAt = 0;
  }
  runtime.hfTabId = null;
  runtime.hfUrl = '';
  runtime.hfVideoId = '';
  runtime.hfEndsAt = 0;
  runtime.hfProgress = { videoId: '', playedMs: 0, maxPosMs: 0, durationMs: 0, ended: false, at: 0 };
  // force: the lock check above already decided this release is allowed.
  await applySettingsPatch({ hfEnabled: false }, { force: true });
  return { ok: true, reason: reason || 'manual' };
}

async function toggleHyperFocus(minutes) {
  return runtime.settings.hfEnabled ? disarmHyperFocus() : armHyperFocus(minutes);
}

// Re-validate after a service worker restart: if the focused tab is gone we must
// disarm, otherwise Hyper Focus would block everything with nothing to focus on.
async function validateHyperFocus() {
  if (!runtime.settings.hfEnabled) return;
  if (runtime.hfTabId == null) { await disarmHyperFocus(); return; }
  try {
    const tab = await chrome.tabs.get(runtime.hfTabId);
    if (!tab || !videoIdOf(tab.url || '')) await disarmHyperFocus();
  } catch (_) {
    await disarmHyperFocus();
  }
}

// A YouTube tab that was already open when the extension was installed or
// reloaded has no content script in it, so every feature silently does nothing
// until the user reloads that tab. Inject into those tabs rather than making
// them figure that out. content.js guards itself against double injection.
async function injectExistingTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: YT_URL_MATCH }); } catch (_) { return; }
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (_) { /* restricted tab, or already present */ }
  }
}

async function openPermissionPage() {
  const now = Date.now();
  if (now - runtime.permissionTabOpenedAt < 20000) return;
  const url = chrome.runtime.getURL(PERMISSION_PATH);
  try {
    const existing = await chrome.tabs.query({ url });
    if (existing && existing.length) {
      await chrome.tabs.update(existing[0].id, { active: true });
      if (existing[0].windowId != null) {
        try { await chrome.windows.update(existing[0].windowId, { focused: true }); } catch (_) {}
      }
    } else {
      await chrome.tabs.create({ url });
    }
    runtime.permissionTabOpenedAt = now;
  } catch (_) {}
}

// ------------------------------------------------------------- arbitration ---

async function reconcile() {
  // Fallback is not permanent: give the hidden detector another chance after a
  // while. Content scripts heartbeat every 15s, which is what drives this.
  if (runtime.fallback && Date.now() - runtime.fallbackAt > FALLBACK_RETRY_MS) {
    runtime.fallback = false;
    runtime.lastError = null;
    await broadcastConfig();
  }

  // With fpFocusOnly on, only tabs that are actually in front count. Otherwise
  // any tab holding a video is enough.
  const inFront = runtime.settings.fpFocusOnly
    ? runtime.engagedTabs.size > 0
    : runtime.activeTabs.size > 0;

  const wantDetection = facePauseWanted() && inFront;
  const keepWarm = facePauseWanted() && runtime.activeTabs.size > 0;
  const pageDriving = runtime.pipTabs.size > 0;
  const wantOffscreen = wantDetection && !pageDriving && !runtime.fallback;

  if (wantOffscreen) {
    if (!runtime.cameraRunning) {
      runtime.cameraRunning = true; // optimistic; offscreen confirms or errors
      runtime.lastError = null;
      // A fresh detector starts from "looking", so don't carry a stale decision
      // and don't leave a tab sitting on a paused video waiting for a change
      // event that will never come.
      runtime.away = false;
      runtime.faceDetected = false;
      await startOffscreenCamera();
      await broadcastAttention();
    } else {
      await sendToOffscreen({ t: 'config', settings: engineConfig() });
    }
    runtime.source = 'offscreen';
    runtime.suspended = false;
  } else if (keepWarm && !pageDriving && !runtime.fallback) {
    // There is still a video open, we are just not looking at that window.
    await suspendOffscreenCamera();
    runtime.source = 'none';
    runtime.suspended = true;
  } else {
    if (runtime.cameraRunning || await hasOffscreen()) await stopOffscreenCamera();
    runtime.source = pageDriving && wantDetection ? 'page' : 'none';
    runtime.suspended = false;
  }

  // Never leave a video stuck paused when Face Pause itself is switched off.
  // Deliberately NOT done when we merely suspended for focus: the user walked
  // away from a paused video, so resuming it behind their back would be wrong.
  if (runtime.away && !facePauseWanted()) {
    runtime.away = false;
    runtime.faceDetected = false;
    await broadcastAttention();
  }

  updateBadge();
}

function updateBadge() {
  const off = !runtime.settings.masterEnabled;
  try {
    chrome.action.setBadgeText({ text: off ? 'off' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#8a8f98' });
  } catch (_) {}
}

// -------------------------------------------------------------- broadcasts ---

// Per-tab, because only one tab is the Hyper Focus target and only that tab
// should hide its own distractions.
function configPayload(tabId) {
  return {
    t: 'config',
    settings: runtime.settings,
    fallback: runtime.fallback,
    source: runtime.source,
    hfFocused: runtime.settings.hfEnabled && tabId != null && tabId === runtime.hfTabId,
    hfEndsAt: runtime.hfEndsAt,
    hfArmed: !!runtime.settings.hfEnabled,
    hfLock: lockState()
  };
}

async function broadcastConfig() {
  try {
    const tabs = await chrome.tabs.query({ url: YT_URL_MATCH });
    for (const tab of tabs) {
      if (tab.id != null) chrome.tabs.sendMessage(tab.id, configPayload(tab.id)).catch(() => {});
    }
  } catch (_) {}
}

async function broadcastAttention() {
  const msg = {
    t: 'attention',
    away: runtime.away,
    faceDetected: runtime.faceDetected,
    source: runtime.source
  };
  for (const tabId of runtime.activeTabs) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
}

async function broadcastCalibrate() {
  // Calibrate whichever detector is live: offscreen and/or any open PiP.
  await sendToOffscreen({ t: 'calibrate' });
  // Also reaches a standalone preview window if one is open.
  chrome.runtime.sendMessage({ t: 'calibrateAll' }).catch(() => {});
  try {
    const tabs = await chrome.tabs.query({ url: YT_URL_MATCH });
    for (const tab of tabs) {
      if (tab.id != null) chrome.tabs.sendMessage(tab.id, { t: 'calibrate' }).catch(() => {});
    }
  } catch (_) {}
}

// `opts.force` is for callers that have already made the lock decision
// themselves -- specifically disarmHyperFocus, which must be able to release on
// tab-closed even while the lock is unmet. Without it these guards would strip
// the very disarm that keeps the user from being stranded.
async function applySettingsPatch(patch, opts) {
  const before = runtime.settings;
  const p = { ...(patch || {}) };

  if (!(opts && opts.force)) {
    // Belt and braces: hfEnabled is meant to travel through armHyperFocus /
    // disarmHyperFocus, which enforce the commitment lock. Strip an attempt to
    // switch it off here so no other surface can route around the lock by
    // writing the setting directly.
    if (p.hfEnabled === false && lockState().locked) delete p.hfEnabled;
    // Lowering the bar mid-session would make the commitment adjustable, so the
    // percentage only moves while no session is running.
    if (p.hfLockPercent !== undefined && before.hfEnabled && lockState().locked) delete p.hfLockPercent;
  }

  runtime.settings = normalizeSettings({ ...before, ...p });
  await saveSettings();
  await broadcastConfig();
  await reconcile();
  return runtime.settings;
}

// ---------------------------------------------------------------- messaging ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages we addressed to the offscreen document are not for us.
  if (msg && msg._to === 'offscreen') return;

  (async () => {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    await checkHyperFocusTimer();

    switch (msg && msg.t) {
      // ------------------------------ from content scripts ------------------
      case 'hello': {
        sendResponse({ ...configPayload(tabId), ok: true, away: runtime.away });
        break;
      }

      // A tab reports whether it currently has a video worth watching. This is
      // what spins the camera up and down (the old build never sent it, so the
      // offscreen detector never ran at all).
      case 'session': {
        if (tabId != null) {
          if (msg.active) runtime.activeTabs.add(tabId);
          else runtime.activeTabs.delete(tabId);
          // `engaged` means visible and focused: the tab is genuinely in front.
          if (msg.active && msg.engaged) runtime.engagedTabs.add(tabId);
          else runtime.engagedTabs.delete(tabId);
          await reconcile();
        }
        sendResponse({ ...configPayload(tabId), ok: true, away: runtime.away });
        break;
      }

      // A tab's in-page detector started/stopped.
      case 'pipActive': {
        if (tabId != null) {
          if (msg.value) runtime.pipTabs.add(tabId);
          else runtime.pipTabs.delete(tabId);
          await reconcile();
        }
        sendResponse({ ok: true, source: runtime.source });
        break;
      }

      // Attention state produced by an in-page detector.
      case 'pipState': {
        if (runtime.pipTabs.size > 0) {
          runtime.away = !!msg.away;
          runtime.faceDetected = !!msg.hasFace;
          if (msg.metrics) runtime.metrics = msg.metrics;
          runtime.source = 'page';
          await broadcastAttention();
        }
        sendResponse({ ok: true });
        break;
      }

      // ------------------------------ from the offscreen document -----------
      case 'offscreenReady': {
        runtime.offscreenReady = true;
        sendResponse({ ok: true });
        break;
      }
      case 'cameraState': {
        runtime.cameraRunning = !!msg.running;
        if (msg.running) {
          runtime.lastError = null;
          runtime.needPermission = false;
          if (runtime.fallback) {
            runtime.fallback = false;
            await broadcastConfig();
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case 'att': {
        runtime.away = !!msg.away;
        runtime.faceDetected = !!msg.faceDetected;
        if (msg.metrics) runtime.metrics = msg.metrics;
        await broadcastAttention();
        sendResponse({ ok: true });
        break;
      }
      case 'metrics': {
        runtime.faceDetected = !!msg.faceDetected;
        runtime.calibrating = !!msg.calibrating;
        if (msg.metrics) runtime.metrics = msg.metrics;
        sendResponse({ ok: true });
        break;
      }
      case 'offscreenError': {
        runtime.lastError = msg.error || 'Unknown camera error';
        runtime.cameraRunning = false;
        if (msg.code === 'NEED_PERMISSION') {
          runtime.needPermission = true;
          await openPermissionPage();
        } else {
          // Camera busy / no device / detector failed to load: let the page try.
          runtime.fallback = true;
          runtime.fallbackAt = Date.now();
          await broadcastConfig();
          await reconcile();
        }
        sendResponse({ ok: true });
        break;
      }

      // ------------------------------ from popup / permission page ----------
      case 'getStatus': {
        sendResponse({
          ok: true,
          settings: runtime.settings,
          cameraRunning: runtime.cameraRunning,
          away: runtime.away,
          faceDetected: runtime.faceDetected,
          calibrating: runtime.calibrating,
          metrics: runtime.metrics,
          activeTabs: runtime.activeTabs.size,
          engagedTabs: runtime.engagedTabs.size,
          pipTabs: runtime.pipTabs.size,
          suspended: runtime.suspended,
          source: runtime.source,
          fallback: runtime.fallback,
          lastError: runtime.lastError,
          needPermission: runtime.needPermission,
          hfTabId: runtime.hfTabId,
          hfUrl: runtime.hfUrl,
          hfBlocked: runtime.hfBlocked,
          hfEndsAt: runtime.hfEndsAt,
          hfLock: lockState()
        });
        break;
      }
      case 'setSettings': {
        const settings = await applySettingsPatch(msg.patch);
        sendResponse({ ok: true, settings });
        break;
      }
      case 'calibrate': {
        await broadcastCalibrate();
        sendResponse({ ok: true });
        break;
      }
      case 'permissionGranted': {
        runtime.lastError = null;
        runtime.needPermission = false;
        runtime.fallback = false;
        runtime.permissionTabOpenedAt = 0;
        // Recreate the offscreen document so it re-checks permission cleanly.
        await stopOffscreenCamera();
        await broadcastConfig();
        await reconcile();
        sendResponse({ ok: true });
        break;
      }
      case 'hyperFocus': {
        let res;
        if (msg.value === true) res = await armHyperFocus(msg.minutes);
        else if (msg.value === false) res = await disarmHyperFocus(msg.reason);
        else res = await toggleHyperFocus(msg.minutes);
        sendResponse({ ...res, settings: runtime.settings, endsAt: runtime.hfEndsAt });
        break;
      }
      case 'progress': {
        // Only the focused tab's progress can satisfy the lock.
        if (tabId != null && tabId === runtime.hfTabId) {
          runtime.hfProgress = {
            videoId: String(msg.videoId || ''),
            playedMs: Math.max(0, Number(msg.playedMs) || 0),
            maxPosMs: Math.max(0, Number(msg.maxPosMs) || 0),
            durationMs: Number(msg.durationMs) || 0,
            ended: !!msg.ended,
            at: Date.now()
          };
          if (msg.ended) await checkHyperFocusTimer();
        }
        sendResponse({ ok: true, lock: lockState() });
        break;
      }
      case 'stats': {
        await addStats(msg.d);
        sendResponse({ ok: true });
        break;
      }
      case 'getStats': {
        const stats = await readStats();
        sendResponse({ ok: true, days: stats.days, today: dayKey(), keepDays: STATS_KEEP_DAYS });
        break;
      }
      case 'clearStats': {
        try { await chrome.storage.local.remove('stats'); } catch (_) {}
        sendResponse({ ok: true });
        break;
      }
      case 'focusedTab': {
        // blocked.html asking where to send the user back to.
        sendResponse({ ok: true, tabId: runtime.hfTabId, url: runtime.hfUrl });
        break;
      }
      case 'gotoFocused': {
        if (runtime.hfTabId != null) {
          try {
            await chrome.tabs.update(runtime.hfTabId, { active: true });
            const t = await chrome.tabs.get(runtime.hfTabId);
            if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
          } catch (_) {}
        }
        sendResponse({ ok: true });
        break;
      }
      case 'retryDetector': {
        runtime.lastError = null;
        runtime.fallback = false;
        await stopOffscreenCamera();
        await broadcastConfig();
        await reconcile();
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();

  return true; // async sendResponse
});

// ------------------------------------------------------- keyboard shortcuts ---

chrome.commands.onCommand.addListener(async (command) => {
  const s = runtime.settings;
  if (command === 'toggle-master') await applySettingsPatch({ masterEnabled: !s.masterEnabled });
  else if (command === 'toggle-face-pause') await applySettingsPatch({ fpEnabled: !s.fpEnabled });
  else if (command === 'toggle-auto-fullscreen') await applySettingsPatch({ afEnabled: !s.afEnabled });
  else if (command === 'toggle-cursor-pause') await applySettingsPatch({ curEnabled: !s.curEnabled });
  else if (command === 'toggle-hyper-focus') await toggleHyperFocus();
  else if (command === 'calibrate') await broadcastCalibrate();
});

// ------------------------------------------------------------- tab tracking ---

chrome.tabs.onRemoved.addListener((tabId) => {
  const wasActive = runtime.activeTabs.delete(tabId);
  const wasEngaged = runtime.engagedTabs.delete(tabId);
  const wasPip = runtime.pipTabs.delete(tabId);
  if (wasActive || wasEngaged || wasPip) reconcile();
  // Losing the focused tab must disarm, or everything stays blocked forever.
  // This overrides the commitment lock deliberately: it is the escape of last
  // resort, and a browser you cannot un-block is worse than a broken promise.
  if (tabId === runtime.hfTabId) disarmHyperFocus('tab-closed');
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  // Hyper Focus / blocklist enforcement runs before anything else.
  enforce(tabId, info.url);
  // Following the focused tab to a different video means leaving the video, so
  // keep hfUrl pinned to what it was armed on rather than tracking navigation.
  // Our own pages (a standalone camera window) are legitimate detectors.
  if (info.url.startsWith('chrome-extension://')) return;
  if (!/:\/\/([^/]*\.)?youtube\.com\//.test(info.url)) {
    const wasActive = runtime.activeTabs.delete(tabId);
    const wasEngaged = runtime.engagedTabs.delete(tabId);
    const wasPip = runtime.pipTabs.delete(tabId);
    if (wasActive || wasEngaged || wasPip) reconcile();
  }
});

// Settings can also be changed from another surface (e.g. a second window).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = normalizeSettings(changes.settings.newValue);
  if (JSON.stringify(next) === JSON.stringify(runtime.settings)) return;
  runtime.settings = next;
  updateBadge();
  reconcile();
});

// ---------------------------------------------------------------- lifecycle ---

chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();
  await validateHyperFocus();
  await injectExistingTabs();
  if (details && details.reason === 'install') {
    // Fresh install: let the user grant the camera up front so the hidden
    // detector can run without ever interrupting a video later.
    try { await chrome.tabs.create({ url: chrome.runtime.getURL(PERMISSION_PATH) }); } catch (_) {}
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  await validateHyperFocus();
  await injectExistingTabs();
});

// New tabs start blank and get their URL via onUpdated, but a tab opened
// straight onto a URL (middle-click, target=_blank) can arrive here first.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab && tab.id != null && tab.url) enforce(tab.id, tab.url);
});

loadSettings().then(validateHyperFocus);
