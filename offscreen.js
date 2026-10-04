// offscreen.js — CinePilot's headless webcam capture + attention detection.
//
// Runs in a hidden offscreen document, which is the preferred detector: it keeps
// working while YouTube is fullscreen and serves every YouTube tab from a single
// camera stream. Drives the shared AttentionEngine and reports "away" state to
// the service worker. All processing is local; nothing is uploaded or stored.
//
// It cannot show a permission prompt, so when the camera is blocked it reports
// code:'NEED_PERMISSION' and the service worker opens permission.html instead.

import { initLandmarker, detect, AttentionEngine } from './detector-core.js';

const video = document.getElementById('cam');
const engine = new AttentionEngine();

let stream = null;
let running = false;
let loopTimer = null;
let lastMetricsPost = 0;

const LOOP_MS = 80; // ~12 fps

function post(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function startCamera() {
  if (running) return;
  try {
    await initLandmarker();
  } catch (e) {
    post({ t: 'offscreenError', error: 'Failed to load detector: ' + (e.message || e) });
    return;
  }

  // Bail early only on a definite denial; otherwise let getUserMedia decide.
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: 'camera' });
      if (status.state === 'denied') {
        post({ t: 'offscreenError', error: 'Camera permission needed.', code: 'NEED_PERMISSION' });
        return;
      }
    }
  } catch (_) {}

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
      audio: false
    });
  } catch (e) {
    const name = e && e.name ? e.name : 'Error';
    let msg = 'Camera error: ' + (e.message || name);
    let code = 'OTHER';
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      msg = 'Camera permission needed.';
      code = 'NEED_PERMISSION';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') msg = 'No camera found on this device.';
    if (name === 'NotReadableError' || name === 'TrackStartError') msg = 'Camera is in use by another application.';
    post({ t: 'offscreenError', error: msg, code });
    return;
  }

  video.srcObject = stream;
  try { await video.play(); } catch (_) {}

  running = true;
  engine.away = false;
  engine.candidate = null;
  engine.noFaceSince = 0;
  post({ t: 'cameraState', running: true });

  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(tick, LOOP_MS);
}

function stopCamera() {
  running = false;
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
  video.srcObject = null;
  engine.away = false;
  engine.candidate = null;
  post({ t: 'cameraState', running: false });
}

function tick() {
  if (!running || video.readyState < 2) return;
  const now = performance.now();
  const result = detect(video, now);
  const snap = engine.process(now, result);

  if (snap.awayChanged) {
    post({
      t: 'att',
      away: snap.away,
      faceDetected: snap.hasFace,
      metrics: { yaw: snap.yaw, pitch: snap.pitch }
    });
  }

  // Throttled live metrics for the popup.
  if (now - lastMetricsPost > 200) {
    lastMetricsPost = now;
    post({
      t: 'metrics',
      faceDetected: snap.hasFace,
      away: snap.away,
      calibrating: snap.calibrating,
      metrics: { yaw: snap.yaw, pitch: snap.pitch }
    });
  }
}

// ---------- messaging from the service worker ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg._to !== 'offscreen') return;
  switch (msg.t) {
    case 'start': startCamera(); sendResponse({ ok: true }); break;
    case 'stop': stopCamera(); sendResponse({ ok: true }); break;
    case 'config': if (msg.settings) engine.setConfig(msg.settings); sendResponse({ ok: true }); break;
    case 'calibrate': engine.requestCalibration(); sendResponse({ ok: true }); break;
    default: sendResponse({ ok: false });
  }
  return true;
});

post({ t: 'offscreenReady' });
