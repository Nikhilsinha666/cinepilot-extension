// content.js — CinePilot for YouTube (runs on youtube.com)
//
// One script, two merged features, one shared <video> layer:
//
//   Auto Fullscreen — clicks YouTube's own fullscreen button when playback
//                     starts, optionally pauses when you leave fullscreen, and
//                     optionally re-enters fullscreen when you return to the tab.
//
//   Face Pause      — pauses/resumes based on the away/looking decision coming
//                     either from the hidden offscreen detector (via the service
//                     worker) or from the in-page camera preview iframe.
//
// The two features fight over the same <video>, so every programmatic play() or
// pause() we perform is wrapped in an "internal operation" window. Handlers
// ignore events raised during that window, which is what keeps a Face Pause
// resume from re-triggering fullscreen and keeps a fullscreen-exit pause from
// being auto-resumed later.

(() => {
  'use strict';
  if (window.__cinePilotInjected) return;
  window.__cinePilotInjected = true;

  // Mirrors DEFAULT_SETTINGS in background.js so the script is usable before
  // the first config message arrives.
  const DEFAULTS = {
    masterEnabled: true,
    fpEnabled: true,
    fpMode: 'head',
    fpSensitivity: 3,
    fpPauseDelayMs: 90,
    fpResumeDelayMs: 220,
    fpRewindSec: 2,
    fpFocusOnly: true,
    fpShowPip: false,
    fpShowIndicator: true,
    afEnabled: true,
    afDelayMs: 500,
    afPauseOnExit: true,
    afRefocus: true,
    curEnabled: false,
    curSensitivityPx: 60,
    curGraceMs: 1500,
    curOnClick: true,
    curToast: true,
    curAutoResume: true,
    curResumeAfterMs: 2000,
    hfEnabled: false,
    hfHideDistractions: true,
    hfMinutes: 0,
    hfLockPercent: 0,
    hfShowBar: true,
    hfAllowlist: [],
    hfBlocklist: [],
    statsEnabled: true
  };

  let S = { ...DEFAULTS };
  let fallback = false; // offscreen detector unavailable -> this page must detect

  // ---- shared video state ----
  let video = null;
  let hasEverPlayed = false;
  let internalOps = 0;

  // ---- face pause state ----
  let away = false;
  let faceDetected = true;
  let autoPaused = false;
  let pausedAtMs = 0;      // wall clock of our last auto-pause
  let resumeAnchor = null; // media time playback last (re)started from

  // A glance shorter than this loses no context, so it gets no rewind.
  const MIN_PAUSE_FOR_REWIND_MS = 600;

  // ---- window engagement (is this tab actually in front) ----
  let engaged = true;
  let engageTimer = null;
  // Grace before releasing the camera, so clicking the address bar or flicking
  // between tabs does not tear the detector down and pay to restart it.
  const UNFOCUS_GRACE_MS = 1500;

  // ---- cursor pause state ----
  // Reaching for the mouse is the moment attention left the video, so mouse
  // activity is the trigger. Movement is measured as distance travelled inside
  // one burst, because a single stray mousemove event is noise -- trackpads and
  // even a nudged desk emit those -- while deliberately moving the pointer
  // covers real distance.
  let curTravel = 0;      // px accumulated in the current burst
  let curBurstAt = 0;     // when the burst started
  let curLastX = null;
  let curLastY = null;
  let curArmedAt = 0;     // ignore the mouse until this timestamp
  let cursorPaused = false;
  const CUR_BURST_MS = 500; // travel outside this window is a separate burst

  let curLastActivityAt = 0;  // any pointer event, eligible or not
  let curResumeChecker = null;

  // ---- hyper focus ----
  let hfFocused = false; // is this the tab Hyper Focus was armed on
  let hfArmed = false;
  let hfEndsAt = 0;
  let hfBtn = null;
  let hfBtnTicker = null;
  let hfExpirySent = false;
  let hfLock = null;      // last lock state the worker reported

  // ---- watch progress for the commitment lock ----
  // Media time genuinely played, not the scrubber position, so seeking to the end
  // proves nothing. maxPos is tracked too, so looping the intro proves nothing.
  let progVideoId = '';
  let progPlayedMs = 0;
  let progMaxPosMs = 0;
  let progLastPos = null;
  let progTicker = null;
  let progSentAt = 0;

  // ---- insights ----
  let statTicker = null;
  let statLastAt = 0;
  let statBuf = null;
  let statFlushAt = 0;
  const STAT_FLUSH_MS = 10000;
  let toastEl = null;
  let toastTimer = null;

  // ---- auto fullscreen state ----
  let afDebouncing = false;
  let afPoller = null;
  let lastExitPauseAt = 0;
  let playerObserver = null;
  let playerObserved = null; // the exact element playerObserver watches

  // ---- ui ----
  let pip = null;
  let frame = null;
  let pipRunning = false;
  let pipDismissed = false; // user closed it on this page
  let indicator = null;
  let dragState = null;
  let resizeState = null;

  // Camera tile size. The default camera area is 150x193, i.e. the 35x45mm
  // proportions of a passport photo, which is small enough to sit over a video
  // without covering anything. Freely resizable between these bounds.
  const PIP_DEFAULT = { w: 150, h: 193 };
  const PIP_MIN = { w: 96, h: 90 };
  const PIP_MAX = { w: 520, h: 660 };
  const PIP_NARROW_AT = 190; // below this the title bar drops its label
  let pipSize = { ...PIP_DEFAULT };

  const send = (msg) => {
    try {
      const p = chrome.runtime.sendMessage(msg);
      return p && p.catch ? p.catch(() => null) : Promise.resolve(null);
    } catch (_) {
      return Promise.resolve(null); // extension reloaded / context invalidated
    }
  };

  const fpActive = () => S.masterEnabled && S.fpEnabled;
  const afActive = () => S.masterEnabled && S.afEnabled;
  const curActive = () => S.masterEnabled && S.curEnabled;

  // =============================================================== video ====

  function findVideo() {
    return document.querySelector('.html5-main-video')
        || document.querySelector('video.video-stream')
        || document.querySelector('video')
        || null;
  }

  function isVideoPage() {
    return /^\/(watch|shorts|embed|live)(\/|$)/.test(location.pathname);
  }

  function isWatchPage() {
    return location.pathname === '/watch';
  }

  function isPlaying() {
    return !!video && !video.paused && !video.ended && video.readyState > 2;
  }

  function beginInternal(ms) {
    internalOps++;
    setTimeout(() => { internalOps = Math.max(0, internalOps - 1); }, ms || 160);
  }
  const isInternal = () => internalOps > 0;

  function attachVideo(v) {
    if (!v || v === video) return;
    detachVideo();
    video = v;
    video.addEventListener('play', onVideoPlay, true);
    video.addEventListener('pause', onVideoPause, true);
    video.addEventListener('ended', onVideoEnded, true);
    if (!video.paused) hasEverPlayed = true;
    pausedAtMs = 0;
    cursorPaused = false; // stale flag would mislabel the new video's indicator
    resumeAnchor = video.paused ? null : video.currentTime;
    armCursorGrace();
    updateSession();
  }

  function detachVideo() {
    if (!video) return;
    video.removeEventListener('play', onVideoPlay, true);
    video.removeEventListener('pause', onVideoPause, true);
    video.removeEventListener('ended', onVideoEnded, true);
    video = null;
  }

  function onVideoPlay() {
    hasEverPlayed = true;
    updateSession();
    // Playback starting always re-arms the grace window, whoever started it.
    // This must happen BEFORE the internal-op check, because you press play with
    // the mouse: without a grace period that very click would pause it again and
    // the video could never be started at all.
    cursorPaused = false;
    stopResumeWatch();
    armCursorGrace();
    if (isInternal()) return; // our own resume: never treat it as a user play

    autoPaused = false;
    // A play the user started is a fresh reference point for the rewind.
    resumeAnchor = video ? video.currentTime : null;
    // Manually resumed while still looking away -> pause again shortly.
    if (fpActive() && away) {
      setTimeout(() => { if (fpActive() && away && isPlaying()) doPause(); }, 60);
    }
    afOnPlay();
    updateIndicator();
  }

  function onVideoPause() {
    if (isInternal()) return;
    autoPaused = false; // the user (or YouTube) paused -> respect it
    updateIndicator();
  }

  function onVideoEnded() {
    autoPaused = false;
    cursorPaused = false;
    updateIndicator();
  }

  // =========================================================== face pause ===

  function doPause() {
    if (!video || video.paused) return;
    beginInternal();
    autoPaused = true;
    pausedAtMs = Date.now();
    try { video.pause(); } catch (_) {}
    countPause('face');
    updateIndicator();
    postToFrame({ type: 'badge', state: 'paused' });
  }

  const isAdShowing = () => {
    const p = player();
    return !!p && p.classList.contains('ad-showing');
  };

  // "Rewind on resume": step the playhead back a little so you get the run-up to
  // whatever you were watching instead of landing mid-sentence.
  //
  // The subtle part is not the seek, it is not walking the video backwards. The
  // pause triggers ~90ms after you look away, so a run of quick glances could
  // each cost you the full rewind while gaining almost nothing — the video would
  // creep in reverse. Two guards prevent that: very short pauses are ignored
  // entirely, and the rewind is never longer than the stretch you have actually
  // watched since playback last (re)started. Net progress is therefore always
  // forward, no matter how twitchy the detection gets.
  function maybeRewind() {
    const sec = Number(S.fpRewindSec) || 0;
    if (sec <= 0 || !video) return;
    // Live streams and ads: leave the playhead alone.
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    if (isAdShowing()) return;
    if (pausedAtMs && Date.now() - pausedAtMs < MIN_PAUSE_FOR_REWIND_MS) return;

    let back = sec;
    if (resumeAnchor !== null) back = Math.min(sec, video.currentTime - resumeAnchor);
    if (back < 0.2) return;

    const target = Math.max(0, video.currentTime - back);
    try {
      video.currentTime = target;
      resumeAnchor = target;
    } catch (_) {}
  }

  // Shared by every resume CinePilot performs, so the rewind and the internal
  // guard apply consistently no matter which feature is handing playback back.
  function performResume() {
    if (!video || !video.paused) return false;
    beginInternal();
    maybeRewind(); // seek first, then play, so you never hear the old position
    try {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
    return true;
  }

  function doResume() {
    if (!video) { autoPaused = false; return; }
    if (!autoPaused) return;          // never resume something we did not pause
    if (!video.paused) { autoPaused = false; return; }
    autoPaused = false;
    performResume();
    updateIndicator();
    postToFrame({ type: 'badge', state: 'playing' });
  }

  function applyAttention() {
    if (!fpActive()) {
      if (autoPaused) doResume();
      updateIndicator();
      return;
    }
    if (away) { if (isPlaying()) doPause(); }
    else if (autoPaused) doResume();
    updateIndicator();
  }

  // ---- session reporting (this is what turns the camera on and off) ----

  function sessionWanted() {
    return fpActive() && !!video && isVideoPage() && hasEverPlayed;
  }

  // Is this window genuinely in front? `document.hidden` catches switching tabs
  // and minimizing; `document.hasFocus()` catches leaving Chrome for another
  // app while the tab is still on screen. Neither is sufficient alone.
  function pageIsEngaged() {
    if (!S.fpFocusOnly) return true;
    return !document.hidden && document.hasFocus();
  }

  function setEngaged(value) {
    if (engaged === value) return;
    engaged = value;
    // Clicking back into the window is itself a mouse action, so give it the
    // same grace a fresh play gets rather than pausing on the way in.
    if (value) armCursorGrace();
    // Release/re-acquire the in-page camera too, not just the background one.
    postToFrame({ type: 'setActive', value });
    updateSession(true);
    updateIndicator();
  }

  function updateEngagement() {
    const now = pageIsEngaged();
    if (engageTimer) { clearTimeout(engageTimer); engageTimer = null; }
    if (now === engaged) return;
    // Coming back is instant. So is the very first evaluation, otherwise a tab
    // opened in the background would report itself as in-front for the whole
    // grace period and briefly spin the camera up for a tab nobody is viewing.
    if (now || lastEngagedSent === null) {
      setEngaged(now);
    } else {
      engageTimer = setTimeout(() => {
        engageTimer = null;
        setEngaged(false);
      }, UNFOCUS_GRACE_MS);
    }
  }

  let lastSessionSent = null;
  let lastEngagedSent = null;
  function updateSession(force) {
    const want = sessionWanted();
    const eng = want && engaged;
    if (!force && want === lastSessionSent && eng === lastEngagedSent) return;
    lastSessionSent = want;
    lastEngagedSent = eng;
    send({ t: 'session', active: want, engaged: eng }).then((res) => {
      if (res && res.ok) applyConfig(res);
    });
  }

  // ========================================================= cursor pause ===
  //
  // Touch the mouse -> the video pauses, and you restart it yourself. The point
  // is that reaching for the mouse IS the moment your attention left the video,
  // so the interaction is the signal. There is no auto-resume on purpose: the
  // movement is what pauses, so resuming on movement would be a contradiction.
  //
  // Two things stop it being unusable:
  //
  //   Threshold. A lone mousemove event means nothing -- trackpads, a nudged
  //   desk and even YouTube's own cursor-reveal produce them. So distance is
  //   accumulated inside a short burst and only a real journey counts.
  //
  //   Grace window. You start a video BY clicking, with the mouse. Without a
  //   grace period after playback starts, that very click would pause it again
  //   instantly and the video could never be played at all.
  //
  // Listeners go on `window` in the CAPTURE phase: YouTube's player handles
  // pointer events for its control overlay and does not always let them bubble,
  // and with Auto Fullscreen on the pointer sits over the player almost always.
  // Capture on window is the first step of the propagation path, so nothing
  // downstream can suppress it.
  const POINTER_OPTS = { capture: true, passive: true };
  const MOVE_EVENTS = ['pointermove', 'mousemove'];
  const CLICK_EVENTS = ['pointerdown', 'mousedown', 'wheel'];
  let curListening = false;

  // performance.now(), not Date.now(): elapsed-time measurements must not be
  // skewed by the system clock changing under us.
  function armCursorGrace() {
    curArmedAt = performance.now() + Math.max(0, Number(S.curGraceMs) || 0);
    curTravel = 0;
    curLastX = null;
    curLastY = null;
  }

  const curThreshold = () => Math.max(5, Number(S.curSensitivityPx) || 60);

  // Only react while the user is genuinely watching: video playing, this window
  // in front. A backgrounded tab is never touched, because people background
  // YouTube on purpose to listen to it.
  function curEligible() {
    return curActive()
      && !!video && !video.paused && !video.ended
      && !document.hidden && document.hasFocus()
      && performance.now() >= curArmedAt;
  }

  function onPointerMove(e) {
    curLastActivityAt = performance.now();
    if (!curEligible()) {
      // Keep the anchor fresh so the first eligible move is not measured
      // against wherever the pointer was minutes ago.
      curLastX = e && typeof e.clientX === 'number' ? e.clientX : curLastX;
      curLastY = e && typeof e.clientY === 'number' ? e.clientY : curLastY;
      curTravel = 0;
      return;
    }
    const x = e && typeof e.clientX === 'number' ? e.clientX : null;
    const y = e && typeof e.clientY === 'number' ? e.clientY : null;
    if (x === null || y === null) return;

    const now = performance.now();
    if (curLastX === null || now - curBurstAt > CUR_BURST_MS) {
      curBurstAt = now;
      curTravel = 0;
      curLastX = x;
      curLastY = y;
      return;
    }

    curTravel += Math.hypot(x - curLastX, y - curLastY);
    curLastX = x;
    curLastY = y;
    if (curTravel >= curThreshold()) cursorPauseNow('mouse moved');
  }

  // A click or a scroll is unambiguous intent, so it does not wait for distance.
  function onPointerAction() {
    curLastActivityAt = performance.now();
    if (!curEligible()) return;
    if (!S.curOnClick) return;
    cursorPauseNow('mouse used');
  }

  // ---- auto-resume once the mouse goes still ----
  //
  // Strictly scoped to pauses this feature caused: `cursorPaused` is the only
  // gate. A video you paused yourself, or one Face Pause stopped, is never
  // touched here. That scoping is the whole point -- otherwise "resume when the
  // mouse stops" would start overriding deliberate pauses.
  function curResumeWait() {
    return Math.max(250, Number(S.curResumeAfterMs) || 2000);
  }

  function curResumeTick() {
    if (!cursorPaused || !S.curAutoResume) { stopResumeWatch(); return; }
    if (!video || !video.paused) { cursorPaused = false; stopResumeWatch(); return; }
    // Not while you are away from the screen or the window: Face Pause would
    // just stop it again, and resuming into an empty room is pointless.
    if (away || document.hidden || !document.hasFocus()) return;
    if (performance.now() - curLastActivityAt < curResumeWait()) return;

    cursorPaused = false;
    stopResumeWatch();
    performResume();
    if (S.curToast) showToast('Resumed - mouse settled');
    updateIndicator();
  }

  function startResumeWatch() {
    if (curResumeChecker || !S.curAutoResume) return;
    curResumeChecker = setInterval(curResumeTick, 250);
  }

  function stopResumeWatch() {
    if (!curResumeChecker) return;
    clearInterval(curResumeChecker);
    curResumeChecker = null;
  }

  function cursorPauseNow(why) {
    if (!video || video.paused) return;
    beginInternal();
    cursorPaused = true;
    autoPaused = false;      // deliberate stop: Face Pause must not undo it
    pausedAtMs = Date.now(); // so a manual resume still applies the rewind
    curTravel = 0;
    try { video.pause(); } catch (_) {}
    if (S.curToast) showToast('Paused - ' + why);
    countPause('cursor');
    if (S.curAutoResume) startResumeWatch();
    updateIndicator();
  }

  function stopCursorWatcher() {
    stopResumeWatch();
    if (!curListening) return;
    curListening = false;
    for (const t of MOVE_EVENTS) window.removeEventListener(t, onPointerMove, POINTER_OPTS);
    for (const t of CLICK_EVENTS) window.removeEventListener(t, onPointerAction, POINTER_OPTS);
    cursorPaused = false;
  }

  function syncCursorWatcher() {
    if (curActive() && !curListening) {
      curListening = true;
      armCursorGrace();
      for (const t of MOVE_EVENTS) window.addEventListener(t, onPointerMove, POINTER_OPTS);
      for (const t of CLICK_EVENTS) window.addEventListener(t, onPointerAction, POINTER_OPTS);
    } else if (!curActive() && curListening) {
      stopCursorWatcher();
      updateIndicator();
    }
  }

  // ============================================================== insights ===
  //
  // The camera already decides whether you are looking at the screen, so turning
  // that into "how much did I actually watch attentively" costs nothing extra.
  //
  // `measuredMs` exists so the numbers cannot lie. Focus time is only knowable
  // while the detector is actually running, so watched time and measured time are
  // tracked separately and the dashboard reports focus as a share of what was
  // measured, never of what was watched. With the camera off you get watch time
  // and nothing else, which is the honest answer.

  function freshStatBuf() {
    return { watchedMs: 0, measuredMs: 0, focusedMs: 0, awayMs: 0, pauses: { face: 0, cursor: 0, fullscreen: 0 } };
  }

  function countPause(kind) {
    if (!S.statsEnabled) return;
    if (!statBuf) statBuf = freshStatBuf();
    if (statBuf.pauses[kind] !== undefined) statBuf.pauses[kind]++;
  }

  function statTick() {
    const now = performance.now();
    const dt = now - statLastAt;
    statLastAt = now;

    if (!S.statsEnabled) return;

    // A gap this large means throttled timers or a sleeping machine, so the
    // elapsed time was not spent watching anything.
    const usable = dt > 0 && dt <= 4000;
    if (usable && video && !video.paused && !video.ended) {
      if (!statBuf) statBuf = freshStatBuf();
      statBuf.watchedMs += dt;

      // Only claim to have measured attention when the detector could actually
      // see you: Face Pause on, and this window in front so the camera is live.
      const measurable = fpActive() && engaged && !document.hidden;
      if (measurable) {
        statBuf.measuredMs += dt;
        if (away || !faceDetected) statBuf.awayMs += dt;
        else statBuf.focusedMs += dt;
      }
    }

    // Flushing must NOT sit behind the playing check. Pause counters accrue at
    // the moment playback stops, so gating the flush on "currently playing" left
    // them stranded in the buffer for the entire length of the pause.
    if (now - statFlushAt >= STAT_FLUSH_MS) flushStats();
  }

  function flushStats() {
    statFlushAt = performance.now();
    if (!statBuf) return;
    const d = statBuf;
    statBuf = null;
    const empty = !d.watchedMs && !d.pauses.face && !d.pauses.cursor && !d.pauses.fullscreen;
    if (empty) return;
    send({ t: 'stats', d });
  }

  function syncStatTicker() {
    if (S.statsEnabled && !statTicker) {
      statLastAt = performance.now();
      statFlushAt = statLastAt;
      statTicker = setInterval(statTick, 1000);
    } else if (!S.statsEnabled && statTicker) {
      clearInterval(statTicker);
      statTicker = null;
      statBuf = null;
    }
  }

  // ========================================================== hyper focus ===
  // The blocking itself is the service worker's job. All this tab does is strip
  // the page down when it is the focused one, so the recommendations rail, the
  // comments and the end cards cannot pull you out of the video you chose.
  function syncHyperFocus() {
    const on = S.masterEnabled && S.hfEnabled && hfFocused && S.hfHideDistractions;
    const root = document.documentElement;
    if (root) root.classList.toggle('cp-hyperfocus', on);
    syncProgressTicker();
    syncHfBtn();
  }

  // ---- watch progress ----

  function currentVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v') || '';
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function resetProgress() {
    progVideoId = currentVideoId();
    progPlayedMs = 0;
    progMaxPosMs = 0;
    progLastPos = null;
    progSentAt = 0;
  }

  function progTick() {
    const id = currentVideoId();
    if (id !== progVideoId) resetProgress();
    if (!video) return;

    const t = Number(video.currentTime) || 0;
    const dur = Number(video.duration);

    if (!video.paused && progLastPos !== null) {
      const d = t - progLastPos;
      // Normal playback advances by roughly the tick interval, and faster at
      // higher playback rates. A jump beyond that is a seek, and a negative jump
      // is a rewind; neither counts as having watched anything.
      if (d > 0 && d <= 5) progPlayedMs += d * 1000;
    }
    progLastPos = t;
    if (t > progMaxPosMs / 1000) progMaxPosMs = t * 1000;
    if (Number.isFinite(dur) && dur > 0) progPlayedMs = Math.min(progPlayedMs, dur * 1000);

    const now = performance.now();
    if (now - progSentAt < 2000) return;
    progSentAt = now;

    // Mirror progress into the camera tile. That tile is often the only CinePilot
    // surface visible while a video plays fullscreen, so the figure has to be
    // readable there and not only in the popup.
    const pct = Number.isFinite(dur) && dur > 0
      ? Math.floor(Math.min(100, (progPlayedMs / (dur * 1000)) * 100))
      : null;
    postToFrame({
      type: 'progress',
      percent: pct,
      need: S.hfLockPercent || 0,
      locked: lockHolding()
    });

    // The worker only needs progress when a commitment actually depends on it.
    if (!(hfArmed && S.hfLockPercent > 0)) return;
    send({
      t: 'progress',
      videoId: progVideoId,
      playedMs: Math.round(progPlayedMs),
      maxPosMs: Math.round(progMaxPosMs),
      durationMs: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : 0,
      ended: !!video.ended
    }).then((res) => {
      if (res && res.lock) { hfLock = res.lock; paintHfBtn(); }
    });
  }

  function syncProgressTicker() {
    // Runs for the camera tile as well as for the lock, so "how much have I
    // watched" is answerable whenever the tile is open.
    const want = !!video && (!!pip || (hfArmed && hfFocused && S.hfLockPercent > 0));
    if (want && !progTicker) {
      resetProgress();
      progTicker = setInterval(progTick, 1000);
    } else if (!want && progTicker) {
      clearInterval(progTicker);
      progTicker = null;
    }
  }

  // ---- the one-click button in the player controls ----
  //
  // Injected into `.ytp-right-controls`, immediately before the captions button,
  // so it sits in the player's own control row. Two reasons that container is the
  // right host: YouTube keeps it in both normal and fullscreen mode, so the button
  // survives going fullscreen for free, and it is inside the player chrome rather
  // than the page body, so the Hyper Focus stylesheet (which strips the page)
  // cannot hide the control that ends Hyper Focus.
  //
  // The duration and the commitment percentage come from settings, so this stays a
  // single-click control: one click starts a session, one click ends it.
  function hfBtnWanted() {
    return S.masterEnabled && S.hfShowBar && isWatchPage();
  }

  const controlsHost = () => document.querySelector('.ytp-right-controls');

  function buildHfBtn() {
    const host = controlsHost();
    if (!host) return false;
    // YouTube rebuilds its controls on navigation and on entering fullscreen, so
    // re-adopt rather than assuming our node is still parented.
    if (hfBtn && hfBtn.parentElement === host) return true;
    if (hfBtn) hfBtn.remove();

    hfBtn = document.createElement('button');
    hfBtn.id = 'cinepilot-hf-btn';
    hfBtn.className = 'ytp-button cp-hfbtn';
    hfBtn.type = 'button';
    hfBtn.setAttribute('aria-label', 'Hyper Focus');
    hfBtn.innerHTML =
      '<span class="cp-hfbtn-in">' +
        '<svg class="cp-hfbtn-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
          '<circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" stroke-width="2"></circle>' +
          '<circle class="cp-hfbtn-pupil" cx="12" cy="12" r="2.7" fill="currentColor"></circle>' +
        '</svg>' +
        '<span class="cp-hfbtn-txt"></span>' +
      '</span>';

    const subs = host.querySelector('.ytp-subtitles-button');
    if (subs) host.insertBefore(hfBtn, subs);
    else host.insertBefore(hfBtn, host.firstChild);

    hfBtn.addEventListener('click', onHfBtnClick);
    return true;
  }

  function onHfBtnClick(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const want = !hfArmed;
    send({ t: 'hyperFocus', value: want, minutes: S.hfMinutes }).then((res) => {
      if (res && res.ok === false) {
        if (res.locked) {
          hfLock = { locked: true, percent: res.percent, need: res.need };
          showToast('Locked in - ' + res.percent + '% of ' + res.need + '% watched');
        } else if (res.error) {
          showToast(res.error);
        }
        paintHfBtn();
        return;
      }
      if (res && res.endsAt !== undefined) hfEndsAt = res.endsAt;
      if (res && res.settings) S = { ...S, ...res.settings };
      hfArmed = want;
      hfExpirySent = false;
      if (want) {
        const bits = [];
        if (S.hfMinutes > 0) bits.push(S.hfMinutes + ' min');
        if (S.hfLockPercent > 0) bits.push('locked until ' + S.hfLockPercent + '%');
        showToast('Hyper Focus on' + (bits.length ? ' - ' + bits.join(', ') : ''));
      } else {
        showToast('Hyper Focus off');
      }
      syncProgressTicker();
      paintHfBtn();
    });
  }

  function removeHfBtn() {
    if (hfBtnTicker) { clearInterval(hfBtnTicker); hfBtnTicker = null; }
    if (hfBtn) { hfBtn.remove(); hfBtn = null; }
  }

  const lockHolding = () => !!(hfArmed && hfLock && hfLock.locked);

  function fmtLeft(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function paintHfBtn() {
    if (!hfBtn) return;
    const txt = hfBtn.querySelector('.cp-hfbtn-txt');
    hfBtn.classList.toggle('cp-on', hfArmed);
    hfBtn.classList.toggle('cp-locked', lockHolding());

    if (!hfArmed) {
      txt.textContent = '';
      const bits = [];
      if (S.hfMinutes > 0) bits.push(S.hfMinutes + ' min');
      if (S.hfLockPercent > 0) bits.push('locked until ' + S.hfLockPercent + '% watched');
      hfBtn.title = 'Hyper Focus - blocks the rest of YouTube'
        + (bits.length ? ' (' + bits.join(', ') + ')' : '');
      return;
    }

    // The commitment lock outranks the countdown: it is the thing actually
    // standing between you and the off switch, so it gets the label.
    if (lockHolding()) {
      txt.textContent = hfLock.percent + '%';
      hfBtn.title = 'Locked in - watch ' + hfLock.need + '% before this can be switched off ('
        + hfLock.percent + '% so far)';
      return;
    }

    if (hfEndsAt > 0) {
      const left = hfEndsAt - Date.now();
      if (left <= 0) {
        txt.textContent = '';
        hfBtn.title = 'Session finished';
        if (!hfExpirySent) {
          hfExpirySent = true;
          send({ t: 'hyperFocus', value: false, reason: 'timer' }).then(() => {
            hfArmed = false;
            hfEndsAt = 0;
            showToast('Hyper Focus session finished');
            paintHfBtn();
          });
        }
        return;
      }
      txt.textContent = fmtLeft(left);
      hfBtn.title = 'Hyper Focus - ' + fmtLeft(left) + ' left, click to end early';
      return;
    }

    txt.textContent = '';
    hfBtn.title = 'Hyper Focus is on - click to end';
  }

  function syncHfBtn() {
    if (!hfBtnWanted()) { removeHfBtn(); return; }
    if (!buildHfBtn()) return; // the player controls do not exist yet
    if (!hfBtnTicker) hfBtnTicker = setInterval(paintHfBtn, 1000);
    paintHfBtn();
  }

  // ------------------------------------------------------------------ toast ---

  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'cinepilot-toast';
      toastEl.className = 'cp-toast';
    }
    mountToast();
    toastEl.textContent = text;
    toastEl.classList.add('cp-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.classList.remove('cp-show');
    }, 1800);
  }

  function mountToast() {
    if (!toastEl) return;
    const host = document.fullscreenElement || document.body || document.documentElement;
    if (host && toastEl.parentElement !== host) host.appendChild(toastEl);
  }

  // ======================================================= auto fullscreen ===

  const player = () => document.querySelector('#movie_player');

  function isYouTubeFullscreen() {
    const p = player();
    return !!p && p.classList.contains('ytp-fullscreen');
  }

  function isMiniPlayer() {
    const p = player();
    if (!p) return false;
    return p.classList.contains('ytp-miniplayer-ui')
        || !!document.querySelector('ytd-miniplayer[active]')
        || !!document.querySelector('#miniplayer.ytd-miniplayer[active]');
  }

  function afOnPlay() {
    if (!afActive() || afDebouncing) return;
    if (!isWatchPage() || isMiniPlayer() || isYouTubeFullscreen() || document.hidden) return;
    goFullscreen();
  }

  function goFullscreen() {
    if (!afActive() || afDebouncing || isYouTubeFullscreen()) return;
    afDebouncing = true;
    setTimeout(() => {
      if (afActive() && isWatchPage() && !isMiniPlayer() && !isYouTubeFullscreen()) {
        const btn = document.querySelector('.ytp-fullscreen-button');
        // Click YouTube's own control rather than requestFullscreen() so the
        // player keeps its internal state consistent.
        if (btn) btn.click();
      }
      setTimeout(() => { afDebouncing = false; }, 1000);
    }, Math.max(0, Number(S.afDelayMs) || 0));
  }

  function stopFullscreenPoller() {
    if (afPoller) { clearInterval(afPoller); afPoller = null; }
  }

  // Catches autoplay that starts before we could attach a 'play' listener
  // (typically a page refresh straight onto a watch URL).
  function startFullscreenPoller() {
    stopFullscreenPoller();
    if (!afActive() || !isWatchPage()) return;
    let polls = 0;
    afPoller = setInterval(() => {
      if (++polls > 100) return stopFullscreenPoller();          // give up after 10s
      if (!afActive() || !isWatchPage()) return stopFullscreenPoller();
      if (isYouTubeFullscreen()) return stopFullscreenPoller();  // already there
      const v = video || findVideo();
      if (v && !v.paused && !isMiniPlayer() && !document.hidden) {
        stopFullscreenPoller();
        goFullscreen();
      }
    }, 100);
  }

  // Pause on leaving fullscreen. Two independent detectors feed this (the DOM
  // fullscreenchange event and YouTube's own ytp-fullscreen class), so it is
  // deduped by time.
  function pauseAfterFullscreenExit() {
    const now = Date.now();
    if (now - lastExitPauseAt < 900) return;
    lastExitPauseAt = now;
    let tries = 0;
    const tryPause = () => {
      const v = video || findVideo();
      if (v && !v.paused) {
        try { v.pause(); } catch (_) {}
        autoPaused = false; // deliberate stop: Face Pause must not undo it
        countPause('fullscreen');
        // This pause surprises people, so say who did it and why.
        showToast('Paused - left fullscreen');
      } else if (!v && tries < 5) {
        tries++;
        setTimeout(tryPause, 150);
      }
    };
    setTimeout(tryPause, 100);
  }

  function attachPlayerClassObserver() {
    const p = player();
    if (!p) return;
    // YouTube can swap #movie_player out; make sure we watch the current one.
    if (playerObserver && playerObserved === p) return;
    if (playerObserver) { playerObserver.disconnect(); playerObserver = null; }
    playerObserved = p;
    let wasFs = p.classList.contains('ytp-fullscreen');
    playerObserver = new MutationObserver(() => {
      const nowFs = isYouTubeFullscreen();
      if (wasFs && !nowFs && afActive() && S.afPauseOnExit && isWatchPage()) {
        setTimeout(pauseAfterFullscreenExit, 200);
      }
      wasFs = nowFs;
    });
    playerObserver.observe(p, { attributes: true, attributeFilter: ['class'] });
  }

  document.addEventListener('fullscreenchange', () => {
    mountIndicator(); // these must live inside the fullscreen element to show
    mountToast();
    if (document.fullscreenElement) return;
    if (afActive() && S.afPauseOnExit && isWatchPage()) pauseAfterFullscreenExit();
  });

  document.addEventListener('visibilitychange', () => {
    updateEngagement();
    updateSession();
    if (document.hidden) return;
    if (!afActive() || !S.afRefocus) return;
    if (!isWatchPage() || isMiniPlayer() || isYouTubeFullscreen()) return;
    setTimeout(() => {
      const v = video || findVideo();
      if (v && !v.paused) goFullscreen();
    }, 400);
  });

  // ========================================================= on-page pill ===

  function buildIndicator() {
    if (indicator) return;
    indicator = document.createElement('div');
    indicator.id = 'cinepilot-indicator';
    indicator.className = 'cp-ind';
    indicator.innerHTML = '<span class="cp-ind-dot"></span><span class="cp-ind-text"></span>';
    mountIndicator();
  }

  // Content outside document.fullscreenElement is not painted, so move the pill
  // into the fullscreen element while fullscreen is active. It is a plain div,
  // so re-parenting costs nothing (unlike the camera iframe, which would
  // reload and drop the camera stream).
  function mountIndicator() {
    if (!indicator) return;
    const host = document.fullscreenElement || document.body || document.documentElement;
    if (host && indicator.parentElement !== host) host.appendChild(indicator);
  }

  function updateIndicator() {
    const show = fpActive() && S.fpShowIndicator && sessionWanted();
    if (!show) {
      if (indicator) indicator.style.display = 'none';
      return;
    }
    buildIndicator();
    mountIndicator();
    indicator.style.display = '';

    let cls = 'cp-ind';
    let text = 'Watching';
    if (cursorPaused) {
      cls += ' cp-away';
      text = S.curAutoResume ? 'Mouse used — resumes when still' : 'Mouse used — paused';
    }
    else if (away && !faceDetected) { cls += ' cp-away'; text = 'No face — paused'; }
    else if (away) { cls += ' cp-away'; text = 'Looking away — paused'; }
    else { cls += ' cp-ok'; }
    indicator.className = cls;
    const t = indicator.querySelector('.cp-ind-text');
    if (t) t.textContent = text;
  }

  function removeIndicator() {
    if (indicator) { indicator.remove(); indicator = null; }
  }

  // ================================================ in-page camera preview ===

  function wantPip() {
    if (!fpActive() || pipDismissed) return false;
    // `fallback` means the background detector is unavailable, so the only way
    // to detect at all is the in-page camera.
    return S.fpShowPip || fallback;
  }

  function buildPip() {
    if (pip) return;
    pip = document.createElement('div');
    pip.id = 'cinepilot-pip';
    pip.className = 'cp-pip';
    pip.innerHTML =
      '<div class="cp-pip-bar" id="cp-pip-bar" title="Drag to move · double-click to reset size">' +
        '<span class="cp-pip-title">Camera</span>' +
        '<div class="cp-pip-actions">' +
          '<button class="cp-pip-btn" id="cp-pip-cal" title="Calibrate (look straight ahead, then click)">&#9673;</button>' +
          '<button class="cp-pip-btn" id="cp-pip-min" title="Minimize">&#8211;</button>' +
          '<button class="cp-pip-btn" id="cp-pip-close" title="Close camera preview">&#215;</button>' +
        '</div>' +
      '</div>' +
      '<div class="cp-pip-body">' +
        '<iframe id="cp-pip-frame" referrerpolicy="no-referrer"></iframe>' +
        '<div class="cp-pip-resize" id="cp-pip-resize" title="Drag to resize"></div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(pip);
    applyPipSize(false);

    frame = pip.querySelector('#cp-pip-frame');
    const src = chrome.runtime.getURL('preview.html') + '?embed=1';
    // Delegate camera access to the extension-origin iframe.
    frame.setAttribute('allow', 'camera ' + new URL(src).origin);
    frame.src = src;

    chrome.storage.local.get(['pipPos', 'pipSize']).then((s) => {
      if (!pip) return;
      const size = s && s.pipSize;
      if (size && Number.isFinite(size.w) && Number.isFinite(size.h)) {
        pipSize = { w: size.w, h: size.h };
      }
      const pos = s && s.pipPos;
      if (pos && typeof pos.left === 'number') {
        pip.style.left = pos.left + 'px';
        pip.style.top = pos.top + 'px';
        pip.style.right = 'auto';
        pip.style.bottom = 'auto';
      }
      applyPipSize(false);
    }).catch(() => {});

    pip.querySelector('#cp-pip-close').addEventListener('click', () => {
      // Dismiss locally as well as in settings, so it stays closed even in
      // fallback mode where wantPip() would otherwise force it straight back.
      pipDismissed = true;
      hidePip();
      send({ t: 'setSettings', patch: { fpShowPip: false } });
    });
    pip.querySelector('#cp-pip-min').addEventListener('click', () => {
      pip.classList.toggle('cp-min');
    });
    pip.querySelector('#cp-pip-cal').addEventListener('click', () => {
      send({ t: 'calibrate' });
    });
    const bar = pip.querySelector('#cp-pip-bar');
    bar.addEventListener('mousedown', startDrag);
    bar.addEventListener('dblclick', () => {
      pipSize = { ...PIP_DEFAULT };
      applyPipSize(true);
    });
    pip.querySelector('#cp-pip-resize').addEventListener('mousedown', startResize);
  }

  // ---- size ----

  function applyPipSize(save) {
    if (!pip) return;
    pipSize.w = Math.round(Math.max(PIP_MIN.w, Math.min(PIP_MAX.w, pipSize.w)));
    pipSize.h = Math.round(Math.max(PIP_MIN.h, Math.min(PIP_MAX.h, pipSize.h)));
    pip.style.setProperty('--cp-w', pipSize.w + 'px');
    pip.style.setProperty('--cp-body-h', pipSize.h + 'px');
    pip.classList.toggle('cp-narrow', pipSize.w < PIP_NARROW_AT);
    clampPipIntoView();
    if (save) chrome.storage.local.set({ pipSize: { ...pipSize } }).catch(() => {});
  }

  // Only meaningful once the tile has been dragged; until then it stays pinned
  // to the bottom-right and CSS keeps it on screen for us.
  function clampPipIntoView() {
    if (!pip || !pip.style.left || pip.style.left === 'auto') return;
    const r = pip.getBoundingClientRect();
    pip.style.left = Math.max(4, Math.min(window.innerWidth - r.width - 4, r.left)) + 'px';
    pip.style.top = Math.max(4, Math.min(window.innerHeight - r.height - 4, r.top)) + 'px';
  }

  function startResize(e) {
    if (e.button !== 0 || !pip) return;
    resizeState = { x: e.clientX, y: e.clientY, w: pipSize.w, h: pipSize.h };
    pip.classList.add('cp-dragging');
    document.addEventListener('mousemove', onResize, true);
    document.addEventListener('mouseup', endResize, true);
    e.preventDefault();
    e.stopPropagation();
  }

  function onResize(e) {
    if (!resizeState) return;
    pipSize.w = resizeState.w + (e.clientX - resizeState.x);
    pipSize.h = resizeState.h + (e.clientY - resizeState.y);
    applyPipSize(false);
  }

  function endResize() {
    document.removeEventListener('mousemove', onResize, true);
    document.removeEventListener('mouseup', endResize, true);
    if (pip) pip.classList.remove('cp-dragging');
    resizeState = null;
    applyPipSize(true);
  }

  function startDrag(e) {
    if (e.button !== 0 || !pip) return;
    const rect = pip.getBoundingClientRect();
    dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    pip.classList.add('cp-dragging');
    document.addEventListener('mousemove', onDrag, true);
    document.addEventListener('mouseup', endDrag, true);
    e.preventDefault();
  }

  function onDrag(e) {
    if (!dragState || !pip) return;
    const left = Math.max(4, Math.min(window.innerWidth - pip.offsetWidth - 4, e.clientX - dragState.dx));
    const top = Math.max(4, Math.min(window.innerHeight - pip.offsetHeight - 4, e.clientY - dragState.dy));
    pip.style.left = left + 'px';
    pip.style.top = top + 'px';
    pip.style.right = 'auto';
    pip.style.bottom = 'auto';
  }

  function endDrag() {
    document.removeEventListener('mousemove', onDrag, true);
    document.removeEventListener('mouseup', endDrag, true);
    if (pip) {
      pip.classList.remove('cp-dragging');
      const rect = pip.getBoundingClientRect();
      chrome.storage.local.set({ pipPos: { left: rect.left, top: rect.top } }).catch(() => {});
    }
    dragState = null;
  }

  function showPip() {
    buildPip();
    pip.style.display = '';
    pushConfigToFrame();
  }

  function hidePip() {
    if (pip) { pip.remove(); pip = null; frame = null; }
    if (pipRunning) {
      pipRunning = false;
      send({ t: 'pipActive', value: false });
    }
    // The local detector is gone; do not leave the video stuck paused while the
    // background detector spins up.
    away = false;
    faceDetected = true;
    if (autoPaused) doResume();
    updateIndicator();
  }

  function syncPipAndProgress() {
    syncPip();
    syncProgressTicker();
  }

  function syncPip() {
    if (wantPip()) {
      // This script runs at document_start, so <body> may not exist yet.
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', syncPip, { once: true });
        return;
      }
      showPip();
    } else if (pip) {
      hidePip();
    }
  }

  function postToFrame(msg) {
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ source: 'cinepilot-parent', ...msg }, '*');
    }
  }

  // Pushes live settings into an open preview. The old build only pushed the
  // mode, so sensitivity changes never reached an already-open camera.
  function pushConfigToFrame() {
    postToFrame({
      type: 'setConfig',
      config: {
        mode: S.fpMode,
        sensitivity: S.fpSensitivity,
        pauseDelayMs: S.fpPauseDelayMs,
        resumeDelayMs: S.fpResumeDelayMs
      }
    });
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'cinepilot-frame') return;
    if (!frame || e.source !== frame.contentWindow) return;

    if (d.type === 'state') {
      away = !!d.away;
      faceDetected = !!d.hasFace;
      applyAttention();
      // Relay so other YouTube tabs follow the same decision.
      send({ t: 'pipState', away, hasFace: faceDetected, metrics: d.metrics });
    } else if (d.type === 'ready') {
      // Only claim to be the detector once the camera is actually live.
      pipRunning = true;
      send({ t: 'pipActive', value: true });
      pushConfigToFrame();
    } else if (d.type === 'suspended') {
      // We asked it to release the camera because this window is not in front.
      // Keep the detector claim so the background one is not woken to take over
      // for a tab the user is not even looking at.
    } else if (d.type === 'error') {
      if (pipRunning) {
        pipRunning = false;
        send({ t: 'pipActive', value: false });
      }
    }
  });

  // ============================================================= messaging ===

  function applyConfig(payload) {
    const prevShowPip = S.fpShowPip;
    if (payload.settings) S = { ...DEFAULTS, ...payload.settings };
    if (typeof payload.fallback === 'boolean') fallback = payload.fallback;
    if (typeof payload.hfFocused === 'boolean') hfFocused = payload.hfFocused;
    if (typeof payload.hfArmed === 'boolean') hfArmed = payload.hfArmed;
    if (payload.hfLock) hfLock = payload.hfLock;
    if (typeof payload.hfEndsAt === 'number') {
      if (payload.hfEndsAt !== hfEndsAt) hfExpirySent = false;
      hfEndsAt = payload.hfEndsAt;
    }

    // Turning the preview back on from the popup undoes a local dismissal.
    if (S.fpShowPip && !prevShowPip) pipDismissed = false;

    if (!fpActive()) {
      away = false;
      faceDetected = true;
      if (autoPaused) doResume();
    }
    if (!afActive()) stopFullscreenPoller();

    updateEngagement();
    syncCursorWatcher();
    syncStatTicker();
    syncPipAndProgress();
    syncHyperFocus();
    if (!cursorPaused || !S.curAutoResume) stopResumeWatch();
    syncPip();
    applyAttention();
    updateSession();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.t) return;

    if (msg.t === 'config') {
      applyConfig(msg);
      sendResponse({ ok: true });
    } else if (msg.t === 'attention') {
      // A live in-page detector outranks the background one for this tab.
      if (!pipRunning) {
        away = !!msg.away;
        faceDetected = msg.faceDetected !== false;
        applyAttention();
      }
      sendResponse({ ok: true });
    } else if (msg.t === 'calibrate') {
      postToFrame({ type: 'calibrate' });
      sendResponse({ ok: true });
    } else if (msg.t === 'ping') {
      sendResponse({ ok: true });
    } else {
      return;
    }
    return true;
  });

  // ============================================================= bootstrap ===

  function scan() {
    const v = findVideo();
    if (v && v !== video) attachVideo(v);
    if (video && !video.paused && !hasEverPlayed) {
      hasEverPlayed = true;
      updateSession();
    }
    attachPlayerClassObserver();
    updateIndicator();
    syncHfBtn();
  }

  function onNavigate() {
    afDebouncing = false;
    if (playerObserver && (!playerObserved || !document.contains(playerObserved))) {
      playerObserver.disconnect();
      playerObserver = null;
      playerObserved = null;
    }
    scan();
    if (isWatchPage()) startFullscreenPoller();
    else stopFullscreenPoller();
    updateSession();
  }

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
      return;
    }
    // YouTube mutates constantly, so keep this path as cheap as possible and
    // let the 2s scan() sweep catch anything subtle.
    if (!video || !video.isConnected) {
      const v = findVideo();
      if (v && v !== video) attachVideo(v);
    }
    if (!playerObserver) attachPlayerClassObserver();
  });
  // documentElement always exists, even at document_start.
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('yt-navigate-finish', onNavigate);
  document.addEventListener('yt-navigate-finish', onNavigate);
  // Leaving Chrome for another app does not change visibility, only focus.
  window.addEventListener('focus', updateEngagement);
  window.addEventListener('blur', updateEngagement);
  setInterval(scan, 2000);

  // The service worker can be torn down and lose its tab bookkeeping; a
  // heartbeat re-registers this tab's session.
  setInterval(() => { if (sessionWanted()) updateSession(true); }, 15000);

  window.addEventListener('pagehide', () => {
    stopFullscreenPoller();
    stopCursorWatcher();
    flushStats();
    if (statTicker) { clearInterval(statTicker); statTicker = null; }
    removeHfBtn();
    if (toastEl) { toastEl.remove(); toastEl = null; }
    removeIndicator();
    hidePip();
    lastSessionSent = false;
    lastEngagedSent = false;
    send({ t: 'session', active: false, engaged: false });
  });

  // Ask the background for the current settings, then start.
  send({ t: 'hello' }).then((res) => {
    if (res && res.ok) applyConfig(res);
    scan();
    if (isWatchPage()) startFullscreenPoller();
  });

  // Fall back to storage if the service worker was slow to wake.
  chrome.storage.local.get('settings').then((s) => {
    if (s && s.settings && lastSessionSent === null) {
      applyConfig({ settings: s.settings });
      scan();
      if (isWatchPage()) startFullscreenPoller();
    }
  }).catch(() => {});
})();
