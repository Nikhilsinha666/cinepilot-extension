// preview.js — CinePilot's live camera view with landmark overlay.
//
// Runs in two modes:
//   embed (?embed=1)  — inside the floating PiP on a YouTube page. It reports its
//                       away/looking decision to the parent content script, which
//                       drives the video. While a PiP is live it is the single
//                       detector and the background one is shut down.
//   standalone        — opened as its own tab/window. It reports to the service
//                       worker instead, so every YouTube tab follows along.
//
// All inference is local. No frames leave the machine.

import { initLandmarker, detect, AttentionEngine } from './detector-core.js';

const EMBED = new URLSearchParams(location.search).get('embed') === '1';
const LOOP_MS = 80; // ~12 fps when embedded

const video = document.getElementById('cam');
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const engine = new AttentionEngine();

const el = {
  big: document.getElementById('bigState'),
  vid: document.getElementById('vidState'),
  face: document.getElementById('roFace'),
  yaw: document.getElementById('roYaw'),
  pitch: document.getElementById('roPitch'),
  decision: document.getElementById('roDecision'),
  yawBar: document.getElementById('yawBar'),
  pitchBar: document.getElementById('pitchBar'),
  yawZone: document.getElementById('yawZone'),
  pitchZone: document.getElementById('pitchZone'),
  ehBar: document.getElementById('ehBar'),
  evBar: document.getElementById('evBar'),
  ehZone: document.getElementById('ehZone'),
  evZone: document.getElementById('evZone'),
  watchPill: document.getElementById('watchPill'),
  watchTxt: document.getElementById('watchTxt'),
  watchFill: document.getElementById('watchFill'),
  sens: document.getElementById('sensitivity'),
  sensVal: document.getElementById('sensVal'),
  calibrate: document.getElementById('calibrateBtn'),
  modeHead: document.getElementById('modeHead'),
  modeEyes: document.getElementById('modeEyes'),
  msg: document.getElementById('msg')
};

let stream = null;
let running = false;
let booted = false;    // model loaded (kept across camera suspend/resume)
let starting = false;
let wantActive = true; // parent can suspend us when the window is not in front
let timer = null;
let lastPost = 0;
let lastSentAway = null;

const post = (m) => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch (_) {} };

function toParent(msg) {
  if (!EMBED) return;
  try { parent.postMessage({ source: 'cinepilot-frame', ...msg }, '*'); } catch (_) {}
}

function setMsg(text, kind) {
  el.msg.textContent = text;
  el.msg.className = 'msg' + (kind ? ' ' + kind : '');
}

// ------------------------------------------------------------------ config ---

function applyMode(mode) {
  engine.setConfig({ mode });
  el.modeHead.classList.toggle('active', mode === 'head');
  el.modeEyes.classList.toggle('active', mode === 'eyes');
  document.body.classList.toggle('mode-eyes', mode === 'eyes');
}

function applyConfig(cfg) {
  if (!cfg) return;
  const patch = {};
  if (cfg.sensitivity != null) {
    const v = Math.max(1, Math.min(5, Number(cfg.sensitivity) || 3));
    patch.sensitivity = v;
    el.sens.value = v;
    el.sensVal.textContent = v;
  }
  if (cfg.pauseDelayMs != null) patch.pauseDelayMs = Number(cfg.pauseDelayMs);
  if (cfg.resumeDelayMs != null) patch.resumeDelayMs = Number(cfg.resumeDelayMs);
  if (Object.keys(patch).length) engine.setConfig(patch);
  if (cfg.mode === 'head' || cfg.mode === 'eyes') applyMode(cfg.mode);
}

function doCalibrate() {
  engine.requestCalibration();
  el.calibrate.textContent = 'Hold still…';
  setTimeout(() => { el.calibrate.textContent = 'Calibrate (look straight, then click)'; }, 1200);
}

// Read the saved settings so the PiP starts in the state the popup shows.
chrome.storage.local.get('settings').then((s) => {
  const set = (s && s.settings) || {};
  applyConfig({
    mode: set.fpMode,
    sensitivity: set.fpSensitivity,
    pauseDelayMs: set.fpPauseDelayMs,
    resumeDelayMs: set.fpResumeDelayMs
  });
}).catch(() => applyMode('head'));

// Live updates from the parent content script (embedded) …
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.source !== 'cinepilot-parent') return;
  if (d.type === 'calibrate') doCalibrate();
  else if (d.type === 'setConfig') applyConfig(d.config);
  else if (d.type === 'setActive') {
    // The page tells us whether its window is in front. Releasing the device
    // here is what actually turns the camera light off.
    wantActive = !!d.value;
    if (wantActive) openCamera();
    else closeCamera('Camera released - this tab is not in front.', true);
  } else if (d.type === 'progress') {
    // Watch progress, mirrored from the page. This tile is often the only
    // CinePilot surface visible while a video plays fullscreen, so the commitment
    // figure needs to be readable here and not only in the popup.
    const pct = typeof d.percent === 'number' ? d.percent : null;
    if (pct === null) { el.watchPill.className = 'watch-pill'; return; }
    const need = Number(d.need) || 0;
    el.watchTxt.textContent = need > 0 ? pct + '% / ' + need + '%' : pct + '% watched';
    el.watchFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    el.watchPill.className = 'watch-pill show'
      + (need > 0 ? (pct >= need ? ' done' : ' locked') : '');
  } else if (d.type === 'badge') {
    // Previously a no-op: now it shows what the page's <video> is actually doing.
    el.vid.textContent = d.state === 'paused' ? 'video paused' : 'video playing';
    el.vid.className = 'vid-state show' + (d.state === 'paused' ? ' paused' : '');
  }
});

// … and from the service worker (standalone window).
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.t === 'calibrateAll') doCalibrate();
  });
} catch (_) {}

// ----------------------------------------------------------------- controls ---

el.sens.addEventListener('input', () => {
  const v = Number(el.sens.value);
  el.sensVal.textContent = v;
  engine.setConfig({ sensitivity: v });
});
el.sens.addEventListener('change', () => {
  post({ t: 'setSettings', patch: { fpSensitivity: Number(el.sens.value) } });
});

el.modeHead.addEventListener('click', () => { applyMode('head'); post({ t: 'setSettings', patch: { fpMode: 'head' } }); });
el.modeEyes.addEventListener('click', () => { applyMode('eyes'); post({ t: 'setSettings', patch: { fpMode: 'eyes' } }); });
el.calibrate.addEventListener('click', () => { doCalibrate(); post({ t: 'calibrate' }); });

// -------------------------------------------------------------------- start ---

async function boot() {
  if (booted) return true;
  try {
    setMsg('Loading detector…');
    await initLandmarker();
    booted = true;
    return true;
  } catch (e) {
    const text = 'Failed to load detector: ' + ((e && e.message) || e);
    setMsg(text, 'err');
    toParent({ type: 'error', error: text });
    return false;
  }
}

async function openCamera() {
  if (running || starting || stream) return;
  starting = true;
  try {
    if (!(await boot())) return;
    if (!wantActive) return; // suspended while the model was loading

    try {
      setMsg('Requesting camera…');
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        audio: false
      });
    } catch (e) {
      const n = (e && e.name) || 'Error';
      let text;
      if (n === 'NotAllowedError') text = 'Camera blocked. Click the camera icon in the address bar, allow it, then reload.';
      else if (n === 'NotReadableError') text = 'Camera is in use by another app. Close it and reload.';
      else if (n === 'NotFoundError') text = 'No camera found on this device.';
      else text = 'Camera error: ' + ((e && e.message) || n);
      setMsg(text, 'err');
      toParent({ type: 'error', error: text, name: n });
      return;
    }

    if (!wantActive) { releaseStream(); return; } // suspended mid-acquisition

    video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise((res) => {
      if (video.readyState >= 2) return res();
      video.onloadeddata = () => res();
      setTimeout(res, 1500);
    });

    // Camera works here, so the extension origin definitely has permission.
    post({ t: 'permissionGranted' });
    // Claim detector duty so the background one shuts down: one camera, one
    // inference loop. Works for the embedded PiP and for a standalone window.
    post({ t: 'pipActive', value: true });
    setMsg('Camera live. Detection running.', 'ok');
    toParent({ type: 'ready' });

    sizeOverlay();
    engine.away = false;
    engine.candidate = null;
    engine.noFaceSince = 0;
    lastSentAway = null;
    running = true;
    if (EMBED) {
      // A timer keeps ticking even when this frame is not being painted (for
      // example while it sits behind YouTube's fullscreen backdrop);
      // requestAnimationFrame would stall there.
      timer = setInterval(tick, LOOP_MS);
    } else {
      requestAnimationFrame(rafLoop);
    }
  } finally {
    starting = false;
  }
}

function releaseStream() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  try { video.srcObject = null; } catch (_) {}
}

// Hands the camera device back so the recording light goes out, while keeping
// the loaded model in memory: coming back then costs a few hundred milliseconds
// instead of reloading 22MB of WASM and weights.
//
// `deliberate` means we suspended on purpose (the window is not in front), so
// this tab keeps its claim on detector duty and the background detector is not
// woken up to take over. A real failure gives the claim up.
function closeCamera(note, deliberate) {
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
  releaseStream();
  try { octx.clearRect(0, 0, overlay.width, overlay.height); } catch (_) {}
  lastSentAway = null;
  if (deliberate) {
    toParent({ type: 'suspended' });
  } else {
    post({ t: 'pipActive', value: false });
    toParent({ type: 'error', error: note || 'stopped' });
  }
  setMsg(note || '');
}

function sizeOverlay() {
  overlay.width = video.videoWidth || 640;
  overlay.height = video.videoHeight || 480;
}

function rafLoop() {
  if (!running) return;
  tick();
  requestAnimationFrame(rafLoop);
}

function tick() {
  if (!running || video.readyState < 2) return;
  if (overlay.width !== (video.videoWidth || overlay.width)) sizeOverlay();

  const now = performance.now();
  const result = detect(video, now);
  const snap = engine.process(now, result);

  draw(result, snap);
  render(snap);

  if (EMBED) {
    if (snap.away !== lastSentAway) {
      lastSentAway = snap.away;
      toParent({
        type: 'state',
        away: snap.away,
        hasFace: snap.hasFace,
        metrics: { yaw: snap.yaw, pitch: snap.pitch }
      });
    }
  } else {
    if (snap.awayChanged) {
      post({ t: 'att', away: snap.away, faceDetected: snap.hasFace, metrics: { yaw: snap.yaw, pitch: snap.pitch } });
    }
    if (now - lastPost > 200) {
      lastPost = now;
      post({
        t: 'metrics',
        faceDetected: snap.hasFace,
        away: snap.away,
        calibrating: snap.calibrating,
        metrics: { yaw: snap.yaw, pitch: snap.pitch }
      });
    }
  }
}

// ----------------------------------------------------------------- painting ---

function draw(result, snap) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!result || !result.faceLandmarks || !result.faceLandmarks.length) return;
  const lm = result.faceLandmarks[0];
  const W = overlay.width, H = overlay.height;

  octx.fillStyle = snap.away ? 'rgba(255,77,77,0.85)' : 'rgba(69,196,99,0.85)';
  for (let i = 0; i < lm.length; i += 5) {
    const p = lm[i];
    octx.beginPath();
    octx.arc(p.x * W, p.y * H, 1.1, 0, Math.PI * 2);
    octx.fill();
  }

  if (lm.length >= 478) { // iris landmarks
    octx.fillStyle = '#39c0ff';
    for (const idx of [468, 473]) {
      const p = lm[idx];
      if (!p) continue;
      octx.beginPath();
      octx.arc(p.x * W, p.y * H, 3.5, 0, Math.PI * 2);
      octx.fill();
    }
  }

  octx.fillStyle = '#ffd000'; // key reference points
  for (const idx of [1, 33, 263, 10, 152]) {
    const p = lm[idx];
    if (!p) continue;
    octx.beginPath();
    octx.arc(p.x * W, p.y * H, 2.5, 0, Math.PI * 2);
    octx.fill();
  }
}

function render(snap) {
  el.face.textContent = snap.hasFace ? 'Yes' : 'No';
  el.yaw.textContent = snap.yaw + '°';
  el.pitch.textContent = snap.pitch + '°';

  if (snap.calibrating) el.decision.textContent = 'Calibrating';
  else if (!snap.hasFace) el.decision.textContent = 'No face';
  else el.decision.textContent = snap.away ? 'Away' : 'Looking';

  el.big.className = 'big-state';
  if (!snap.hasFace) { el.big.classList.add('noface'); el.big.textContent = 'NO FACE → PAUSED'; }
  else if (snap.away) { el.big.classList.add('paused'); el.big.textContent = '⏸ PAUSED (looking away)'; }
  else { el.big.classList.add('watching'); el.big.textContent = '▶ WATCHING'; }

  const T = snap.thresholds;
  setBar(el.yawBar, el.yawZone, snap.yaw, T.yawMax, 40);
  setBar(el.pitchBar, el.pitchZone, snap.pitch, T.pitchMax, 30);
  setBar(el.ehBar, el.ehZone, snap.eyeH, T.eyeHMax, 0.35);
  setBar(el.evBar, el.evZone, snap.eyeV, T.eyeVMax, 0.30);
}

function setBar(marker, zone, value, threshold, max) {
  const clamped = Math.max(-max, Math.min(max, value || 0));
  marker.style.left = (50 + (clamped / max) * 50) + '%';
  const ratio = Math.abs(clamped) / threshold;
  marker.style.background = ratio >= 1 ? '#ff4d4d' : ratio > 0.7 ? '#ffb300' : '#45c463';
  zone.style.width = Math.min(100, (threshold / max) * 100) + '%';
}

// Pointer activity inside this tile is deliberately NOT forwarded to the host
// page. Under the old idle-based cursor pause it had to be, so that hovering the
// tile counted as "still here". Now that mouse activity is what *pauses* the
// video, forwarding it would mean dragging, resizing or calibrating the camera
// tile pauses what you are watching. This tile is extension chrome, not content.

// --------------------------------------------------------------- shutdown ----

window.addEventListener('pagehide', () => {
  wantActive = false;
  closeCamera('', false);
});

if (EMBED) document.body.classList.add('embed');
openCamera();
