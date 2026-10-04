// popup.js — CinePilot control panel. All state lives in the service worker;
// this window is a thin view over {t:'getStatus'} plus {t:'setSettings'} patches.

const $ = (id) => document.getElementById(id);

const els = {
  masterEnabled: $('masterEnabled'),

  stateDot: $('stateDot'),
  stateText: $('stateText'),
  sourceText: $('sourceText'),
  metrics: $('metrics'),
  yawBar: $('yawBar'),
  pitchBar: $('pitchBar'),

  permBanner: $('permBanner'),
  permMsg: $('permMsg'),
  grantBtn: $('grantBtn'),

  afCard: $('afCard'),
  afSub: $('afSub'),
  afEnabled: $('afEnabled'),
  afPauseOnExit: $('afPauseOnExit'),
  afRefocus: $('afRefocus'),
  afDelayMs: $('afDelayMs'),
  afDelayVal: $('afDelayVal'),

  fpCard: $('fpCard'),
  fpSub: $('fpSub'),
  fpEnabled: $('fpEnabled'),
  fpSensitivity: $('fpSensitivity'),
  sensHint: $('sensHint'),
  fpRewindSec: $('fpRewindSec'),
  fpRewindVal: $('fpRewindVal'),
  rewindHint: $('rewindHint'),
  fpFocusOnly: $('fpFocusOnly'),
  fpShowPip: $('fpShowPip'),
  fpShowIndicator: $('fpShowIndicator'),
  optHead: $('optHead'),
  optEyes: $('optEyes'),
  modeHint: $('modeHint'),
  calibrateBtn: $('calibrateBtn'),
  windowBtn: $('windowBtn'),

  curCard: $('curCard'),
  curSub: $('curSub'),
  curEnabled: $('curEnabled'),
  curSensitivityPx: $('curSensitivityPx'),
  curSensVal: $('curSensVal'),
  curSensHint: $('curSensHint'),
  curGraceMs: $('curGraceMs'),
  curGraceVal: $('curGraceVal'),
  curOnClick: $('curOnClick'),
  curToast: $('curToast'),
  curAutoResume: $('curAutoResume'),
  curResumeAfterMs: $('curResumeAfterMs'),
  curResumeVal: $('curResumeVal'),
  resumeRow: $('resumeRow'),

  hfCard: $('hfCard'),
  hfSub: $('hfSub'),
  hfEnabled: $('hfEnabled'),
  hfMinutes: $('hfMinutes'),
  hfMinsVal: $('hfMinsVal'),
  hfLockPercent: $('hfLockPercent'),
  hfLockVal: $('hfLockVal'),
  hfLockHint: $('hfLockHint'),
  hfHideDistractions: $('hfHideDistractions'),
  hfShowBar: $('hfShowBar'),
  hfHint: $('hfHint'),
  listsBtn: $('listsBtn'),

  statsEnabled: $('statsEnabled'),
  statsToday: $('statsToday'),
  insightsBtn: $('insightsBtn'),

  footHint: $('footHint'),
  shortcutsLink: $('shortcutsLink'),

  confirmWrap: $('confirmWrap'),
  confirmTitle: $('confirmTitle'),
  confirmBody: $('confirmBody'),
  confirmYes: $('confirmYes'),
  confirmNo: $('confirmNo')
};

// A commitment you cannot easily undo deserves an explicit yes. Resolves true or
// false; while it is open the status poll is suppressed so the card cannot be
// yanked out from under the question.
let confirmPending = null;
function askConfirm(title, body) {
  els.confirmTitle.textContent = title;
  els.confirmBody.textContent = body;
  els.confirmWrap.classList.remove('hidden');
  touch();
  return new Promise((resolve) => { confirmPending = resolve; });
}

function closeConfirm(answer) {
  els.confirmWrap.classList.add('hidden');
  const r = confirmPending;
  confirmPending = null;
  if (r) r(answer);
}

els.confirmYes.addEventListener('click', () => closeConfirm(true));
els.confirmNo.addEventListener('click', () => closeConfirm(false));
els.confirmWrap.addEventListener('click', (e) => { if (e.target === els.confirmWrap) closeConfirm(false); });
document.addEventListener('keydown', (e) => {
  if (confirmPending && e.key === 'Escape') closeConfirm(false);
});

const MODE_HINTS = {
  head: 'Pauses when you turn or tilt your head away from the screen.',
  eyes: 'Pauses when your eyes look away, even if your head barely moves.'
};

const SENS_HINTS = {
  1: 'Very lenient — only big head turns or a missing face pause it.',
  2: 'Lenient — tolerates a fair bit of movement.',
  3: 'Balanced — pauses on a clear look away.',
  4: 'Strict — small turns will pause the video.',
  5: 'Very strict — even a quick glance away pauses it.'
};

const secs = (ms) => (Number(ms) / 1000).toFixed(1) + 's';

// The threshold is the difference between "usable" and "pauses when you breathe",
// so describe it in terms the user can picture rather than raw pixels.
function sensHintText(px) {
  if (px <= 15) return 'Hair trigger: the smallest twitch pauses. Expect false positives from trackpads.';
  if (px <= 40) return 'Sensitive: a small deliberate nudge pauses it.';
  if (px <= 120) return 'Balanced: reaching for the mouse pauses, a bumped desk usually will not.';
  if (px <= 250) return 'Relaxed: you have to actually move across the screen.';
  return 'Very relaxed: only a big sweep across the screen counts.';
}

function lockHintText(pct, st) {
  if (!pct) return 'Off: you can switch Hyper Focus off whenever you like.';
  const lock = st && st.hfLock;
  if (lock && lock.locked) {
    return `Locked in. ${lock.percent}% of ${lock.need}% watched. Progress counts media actually played, so seeking ahead does not help.`;
  }
  return `Once armed you cannot switch it off until ${pct}% of the video has genuinely played. Closing the tab still ends the session.`;
}

function hfHintText(st) {
  const s = st.settings || {};
  if (!s.hfEnabled) return 'Turn this on while a video is open and that video becomes the only thing you can reach. The bar under the player does it in one click.';
  if (st.hfTabId == null) return 'Armed but no video tab is held. Open a video and toggle it again.';
  if (st.hfLock && st.hfLock.locked) {
    return `Locked until ${st.hfLock.need}% watched - currently ${st.hfLock.percent}%.`;
  }

  const bits = [];
  if (st.hfEndsAt > 0) {
    const left = Math.max(0, st.hfEndsAt - Date.now());
    const m = Math.floor(left / 60000);
    const s2 = Math.floor((left % 60000) / 1000);
    bits.push(`${m}:${String(s2).padStart(2, '0')} left`);
  } else {
    bits.push('No time limit');
  }
  const n = st.hfBlocked || 0;
  if (n) bits.push(`${n} navigation${n === 1 ? '' : 's'} turned away`);
  return bits.join(' - ') + '.';
}

const rewindLabel = (v) => (v <= 0 ? 'Off' : v.toFixed(1) + 's');
const rewindHint = (v) => (v <= 0
  ? 'Resumes exactly where it paused.'
  : `Steps back ${v.toFixed(1)}s when it resumes, so you get the run-up instead of landing mid-sentence.`);

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

// While the user is actively dragging a slider or flipping a switch, don't let
// the 700ms poll write over the control they're holding.
let touchedAt = 0;
const touch = () => { touchedAt = Date.now(); };
const settling = () => Date.now() - touchedAt < 1200;

function setMetricBar(el, value, max) {
  const clamped = Math.max(-max, Math.min(max, value || 0));
  el.style.left = (50 + (clamped / max) * 50) + '%';
  const ratio = Math.abs(clamped) / max;
  el.style.background = ratio > 0.85 ? 'var(--accent)' : ratio > 0.6 ? 'var(--amber)' : 'var(--green)';
}

function describeSource(st) {
  const s = st.settings || {};
  if (!s.masterEnabled) return 'Everything is paused.';
  if (!s.fpEnabled) return 'Face Pause is off, so the camera stays off too.';
  if (st.suspended) return 'Released the camera because no YouTube window is in front. It comes back when you return.';
  if (st.fallback) return 'Using the on-page camera preview because the background detector could not start.';
  if (st.source === 'offscreen') return 'Detecting in the background — keeps working in fullscreen.';
  if (st.source === 'page') return 'Detecting in the on-page camera preview.';
  if (st.activeTabs === 0) return 'The camera turns on once a YouTube video is playing.';
  return 'Starting the detector…';
}

// Last settings the worker reported, so a cancelled confirmation knows what to
// revert the slider to.
let lastSettings = {};

function render(st) {
  if (!st || !st.ok) return;
  const s = st.settings || {};
  lastSettings = s;
  const fpLive = s.masterEnabled && s.fpEnabled && (st.cameraRunning || st.source === 'page');

  // ---- controls ----
  if (!settling()) {
    els.masterEnabled.checked = !!s.masterEnabled;

    els.afEnabled.checked = !!s.afEnabled;
    els.afPauseOnExit.checked = !!s.afPauseOnExit;
    els.afRefocus.checked = !!s.afRefocus;
    els.afDelayMs.value = s.afDelayMs;

    els.fpEnabled.checked = !!s.fpEnabled;
    els.fpSensitivity.value = s.fpSensitivity;
    els.fpRewindSec.value = s.fpRewindSec;
    els.fpFocusOnly.checked = !!s.fpFocusOnly;
    els.fpShowPip.checked = !!s.fpShowPip;
    els.fpShowIndicator.checked = !!s.fpShowIndicator;

    els.curEnabled.checked = !!s.curEnabled;
    els.curSensitivityPx.value = s.curSensitivityPx;
    els.curGraceMs.value = s.curGraceMs;
    els.curOnClick.checked = !!s.curOnClick;
    els.curToast.checked = !!s.curToast;
    els.curAutoResume.checked = !!s.curAutoResume;
    els.curResumeAfterMs.value = s.curResumeAfterMs;

    els.hfEnabled.checked = !!s.hfEnabled;
    els.hfMinutes.value = s.hfMinutes;
    els.hfLockPercent.value = s.hfLockPercent;
    els.hfHideDistractions.checked = !!s.hfHideDistractions;
    els.hfShowBar.checked = !!s.hfShowBar;

    els.statsEnabled.checked = !!s.statsEnabled;
  }
  els.afDelayVal.textContent = (Number(els.afDelayMs.value) / 1000).toFixed(1) + 's';
  els.sensHint.textContent = SENS_HINTS[Number(els.fpSensitivity.value) || 3];
  const rw = Number(els.fpRewindSec.value) || 0;
  els.fpRewindVal.textContent = rewindLabel(rw);
  els.rewindHint.textContent = rewindHint(rw);
  const px = Number(els.curSensitivityPx.value) || 60;
  els.curSensVal.textContent = px + 'px';
  els.curSensHint.textContent = sensHintText(px);
  els.curGraceVal.textContent = secs(Number(els.curGraceMs.value) || 0);
  els.curResumeVal.textContent = secs(Number(els.curResumeAfterMs.value) || 0);
  els.resumeRow.classList.toggle('off', !els.curAutoResume.checked);

  const mins = Number(els.hfMinutes.value) || 0;
  els.hfMinsVal.textContent = mins === 0 ? 'No limit' : mins + ' min';

  const lockPct = Number(els.hfLockPercent.value) || 0;
  els.hfLockVal.textContent = lockPct === 0 ? 'Off' : lockPct + '%';
  els.hfLockHint.textContent = lockHintText(lockPct, st);
  // The bar cannot be moved mid-session, or the commitment would be adjustable.
  els.hfLockPercent.disabled = !!(st.hfLock && st.hfLock.locked);

  els.hfEnabled.disabled = !!(st.hfLock && st.hfLock.locked);
  els.hfHint.textContent = hfHintText(st);

  const mode = s.fpMode === 'eyes' ? 'eyes' : 'head';
  els.optHead.classList.toggle('active', mode === 'head');
  els.optEyes.classList.toggle('active', mode === 'eyes');
  els.modeHint.textContent = MODE_HINTS[mode];

  // ---- enabled/disabled sections ----
  els.afCard.classList.toggle('off', !s.masterEnabled || !s.afEnabled);
  els.afSub.classList.toggle('off', !s.masterEnabled || !s.afEnabled);
  els.fpCard.classList.toggle('off', !s.masterEnabled || !s.fpEnabled);
  els.fpSub.classList.toggle('off', !s.masterEnabled || !s.fpEnabled);
  els.curCard.classList.toggle('off', !s.masterEnabled || !s.curEnabled);
  els.curSub.classList.toggle('off', !s.masterEnabled || !s.curEnabled);
  els.hfCard.classList.toggle('off', !s.masterEnabled || !s.hfEnabled);
  els.hfSub.classList.toggle('off', !s.masterEnabled || !s.hfEnabled);

  // ---- banner ----
  const err = st.lastError || '';
  if (st.needPermission) {
    els.permBanner.classList.remove('hidden');
    els.permMsg.textContent = 'Face Pause needs camera access. Auto Fullscreen keeps working either way.';
    els.grantBtn.textContent = 'Grant camera access';
    els.grantBtn.dataset.action = 'grant';
  } else if (err && s.masterEnabled && s.fpEnabled) {
    els.permBanner.classList.remove('hidden');
    els.permMsg.textContent = err;
    els.grantBtn.textContent = 'Retry detector';
    els.grantBtn.dataset.action = 'retry';
  } else {
    els.permBanner.classList.add('hidden');
  }

  // ---- status ----
  const dot = els.stateDot;
  dot.className = 'state-dot';
  if (!s.masterEnabled) {
    dot.classList.add('off');
    els.stateText.textContent = 'CinePilot is off';
  } else if (!s.fpEnabled && !s.afEnabled && !s.curEnabled && !s.hfEnabled) {
    dot.classList.add('off');
    els.stateText.textContent = 'All features are off';
  } else if (!s.fpEnabled) {
    dot.classList.add('on');
    const on = [];
    if (s.afEnabled) on.push('Auto Fullscreen');
    if (s.curEnabled) on.push('Cursor Pause');
    if (s.hfEnabled) on.push('Hyper Focus');
    if (!on.length) on.push('Nothing');
    els.stateText.textContent = on.join(' + ') + ' ready';
  } else if (st.away) {
    dot.classList.add('away');
    els.stateText.textContent = st.faceDetected ? 'Paused — looking away' : 'Paused — no face';
  } else if (fpLive) {
    dot.classList.add('on');
    els.stateText.textContent = 'Watching you watch';
  } else if (st.suspended) {
    dot.classList.add('idle');
    els.stateText.textContent = 'Camera off — YouTube not in front';
  } else {
    dot.classList.add('idle');
    els.stateText.textContent = st.activeTabs === 0 ? 'Waiting for a video' : 'Starting camera…';
  }

  els.sourceText.textContent = describeSource(st);

  els.metrics.classList.toggle('hidden', !fpLive);
  if (fpLive) {
    const m = st.metrics || { yaw: 0, pitch: 0 };
    setMetricBar(els.yawBar, m.yaw, 40);
    setMetricBar(els.pitchBar, m.pitch, 30);
  }

  els.footHint.textContent = st.activeTabs > 0
    ? (st.activeTabs === 1 ? '1 video tab connected' : st.activeTabs + ' video tabs connected')
    : 'Open a YouTube video to see it work.';
}

// Today's line comes from a separate read and changes slowly, so it is polled
// far less often than the live status.
let statsPollAt = 0;
async function refreshStatsLine(force) {
  if (!force && Date.now() - statsPollAt < 5000) return;
  statsPollAt = Date.now();
  const res = await send({ t: 'getStats' });
  if (!res || !res.ok) return;
  const d = (res.days && res.days[res.today]) || {};
  const watched = Number(d.watchedMs) || 0;
  const measured = Number(d.measuredMs) || 0;
  const focused = Number(d.focusedMs) || 0;

  if (!watched) { els.statsToday.textContent = 'No focus recorded yet today.'; return; }
  const mins = (ms) => (ms >= 3600000
    ? Math.floor(ms / 3600000) + 'h ' + Math.round((ms % 3600000) / 60000) + 'm'
    : Math.max(1, Math.round(ms / 60000)) + 'm');

  if (measured <= 0) {
    els.statsToday.textContent = `Today: ${mins(watched)} watched. Turn Face Pause on to measure attention.`;
    return;
  }
  const p = Math.round((focused / measured) * 100);
  els.statsToday.textContent = `Today: ${mins(watched)} watched, ${mins(focused)} focused (${p}% of measured).`;
}

async function refresh() {
  // Never repaint underneath an open question.
  if (confirmPending) return;
  render(await send({ t: 'getStatus' }));
  refreshStatsLine();
}

async function patch(p) {
  touch();
  const res = await send({ t: 'setSettings', patch: p });
  if (res && res.ok) refresh();
}

// ------------------------------------------------------------------ wiring ---

els.masterEnabled.addEventListener('change', () => patch({ masterEnabled: els.masterEnabled.checked }));

els.afEnabled.addEventListener('change', () => patch({ afEnabled: els.afEnabled.checked }));
els.afPauseOnExit.addEventListener('change', () => patch({ afPauseOnExit: els.afPauseOnExit.checked }));
els.afRefocus.addEventListener('change', () => patch({ afRefocus: els.afRefocus.checked }));
els.afDelayMs.addEventListener('input', () => {
  touch();
  els.afDelayVal.textContent = (Number(els.afDelayMs.value) / 1000).toFixed(1) + 's';
});
els.afDelayMs.addEventListener('change', () => patch({ afDelayMs: Number(els.afDelayMs.value) }));

els.fpEnabled.addEventListener('change', () => patch({ fpEnabled: els.fpEnabled.checked }));
els.fpFocusOnly.addEventListener('change', () => patch({ fpFocusOnly: els.fpFocusOnly.checked }));
els.fpShowPip.addEventListener('change', () => patch({ fpShowPip: els.fpShowPip.checked }));
els.fpShowIndicator.addEventListener('change', () => patch({ fpShowIndicator: els.fpShowIndicator.checked }));
els.fpSensitivity.addEventListener('input', () => {
  touch();
  els.sensHint.textContent = SENS_HINTS[Number(els.fpSensitivity.value) || 3];
});
els.fpSensitivity.addEventListener('change', () => patch({ fpSensitivity: Number(els.fpSensitivity.value) }));
els.fpRewindSec.addEventListener('input', () => {
  touch();
  const v = Number(els.fpRewindSec.value) || 0;
  els.fpRewindVal.textContent = rewindLabel(v);
  els.rewindHint.textContent = rewindHint(v);
});
els.fpRewindSec.addEventListener('change', () => patch({ fpRewindSec: Number(els.fpRewindSec.value) }));

els.curEnabled.addEventListener('change', () => patch({ curEnabled: els.curEnabled.checked }));
els.curOnClick.addEventListener('change', () => patch({ curOnClick: els.curOnClick.checked }));
els.curToast.addEventListener('change', () => patch({ curToast: els.curToast.checked }));
els.curSensitivityPx.addEventListener('input', () => {
  touch();
  const px = Number(els.curSensitivityPx.value) || 60;
  els.curSensVal.textContent = px + 'px';
  els.curSensHint.textContent = sensHintText(px);
});
els.curSensitivityPx.addEventListener('change', () => patch({ curSensitivityPx: Number(els.curSensitivityPx.value) }));
els.curGraceMs.addEventListener('input', () => {
  touch();
  els.curGraceVal.textContent = secs(els.curGraceMs.value);
});
els.curGraceMs.addEventListener('change', () => patch({ curGraceMs: Number(els.curGraceMs.value) }));
els.curAutoResume.addEventListener('change', () => patch({ curAutoResume: els.curAutoResume.checked }));
els.curResumeAfterMs.addEventListener('input', () => {
  touch();
  els.curResumeVal.textContent = secs(els.curResumeAfterMs.value);
});
els.curResumeAfterMs.addEventListener('change', () => patch({ curResumeAfterMs: Number(els.curResumeAfterMs.value) }));

els.hfMinutes.addEventListener('input', () => {
  touch();
  const m = Number(els.hfMinutes.value) || 0;
  els.hfMinsVal.textContent = m === 0 ? 'No limit' : m + ' min';
});
els.hfLockPercent.addEventListener('input', () => {
  touch();
  const v = Number(els.hfLockPercent.value) || 0;
  els.hfLockVal.textContent = v === 0 ? 'Off' : v + '%';
  els.hfLockHint.textContent = lockHintText(v, { settings: {} });
});

// Both of these make Hyper Focus harder to escape, so raising either one asks
// first. Lowering is always safe and applies straight away -- nagging on the way
// back down would just train people to click through the dialog.
els.hfMinutes.addEventListener('change', async () => {
  const v = Number(els.hfMinutes.value) || 0;
  const was = Number(lastSettings.hfMinutes) || 0;
  if (v > was) {
    const okd = await askConfirm(
      `Lock yourself in for ${v} minutes?`,
      `Once a session starts, the rest of YouTube stays blocked for ${v} minutes.`
      + (lastSettings.hfLockPercent > 0
        ? ` Your ${lastSettings.hfLockPercent}% watch commitment still has to be met first.`
        : ' Closing the video tab always ends a session.')
    );
    if (!okd) { els.hfMinutes.value = was; touchedAt = 0; refresh(); return; }
  }
  patch({ hfMinutes: v });
});

els.hfLockPercent.addEventListener('change', async () => {
  const v = Number(els.hfLockPercent.value) || 0;
  const was = Number(lastSettings.hfLockPercent) || 0;
  if (v > was) {
    const okd = await askConfirm(
      v >= 90 ? `Commit to watching ${v}%?` : `Lock until ${v}% watched?`,
      `Once Hyper Focus is on you will not be able to switch it off until ${v}% of the`
      + ' video has genuinely played. Seeking ahead does not count. Closing the video'
      + ' tab is the only way out before then.'
    );
    if (!okd) { els.hfLockPercent.value = was; touchedAt = 0; refresh(); return; }
  }
  patch({ hfLockPercent: v });
});
els.hfShowBar.addEventListener('change', () => patch({ hfShowBar: els.hfShowBar.checked }));

els.statsEnabled.addEventListener('change', async () => {
  await patch({ statsEnabled: els.statsEnabled.checked });
  refreshStatsLine(true);
});
els.insightsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('insights.html') });
  window.close();
});

// Hyper Focus is not a plain setting: arming it has to pick a tab and a video,
// so it goes through the service worker instead of a settings patch.
els.hfEnabled.addEventListener('change', async () => {
  touch();
  const want = els.hfEnabled.checked;
  const res = await send({ t: 'hyperFocus', value: want, minutes: undefined });
  if (res && res.ok === false) {
    // Snap the switch back and say why. A refusal must be visible, not silent.
    els.hfEnabled.checked = !want;
    els.hfHint.textContent = res.error || 'Could not change Hyper Focus.';
    touchedAt = 0; // let the next poll correct the rest of the UI
    return;
  }
  refresh();
});
els.hfHideDistractions.addEventListener('change', () => patch({ hfHideDistractions: els.hfHideDistractions.checked }));
els.listsBtn.addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  window.close();
});

els.optHead.addEventListener('click', () => patch({ fpMode: 'head' }));
els.optEyes.addEventListener('click', () => patch({ fpMode: 'eyes' }));

els.calibrateBtn.addEventListener('click', async () => {
  els.calibrateBtn.textContent = 'Hold still…';
  await send({ t: 'calibrate' });
  setTimeout(() => { els.calibrateBtn.textContent = 'Calibrate neutral pose'; }, 1200);
});

els.windowBtn.addEventListener('click', async () => {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('preview.html'),
      type: 'popup',
      width: 440,
      height: 700
    });
  } catch (_) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') });
  }
  window.close();
});

els.grantBtn.addEventListener('click', async () => {
  if (els.grantBtn.dataset.action === 'retry') {
    await send({ t: 'retryDetector' });
    refresh();
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  window.close();
});

els.shortcutsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

refresh();
setInterval(refresh, 700);
