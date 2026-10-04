// detector-core.js — CinePilot's shared face/head-pose + eye-gaze detection.
//
// Imported as an ES module by both detector hosts: offscreen.js (hidden, the
// preferred detector) and preview.js (the visible camera window / in-page PiP).
// The service worker cannot import it because it is a classic worker.
//
// Two modes:
//   'head'  — pause based on head orientation (yaw = left/right, pitch = up/down)
//   'eyes'  — pause based on head OR eye-gaze direction (more sensitive)
//
// Head pose is computed from the 3D face-normal (symmetric for both axes).
// Eye gaze is computed from iris position relative to the eye opening.
// Everything runs locally.

import { FaceLandmarker, FilesetResolver } from './vendor/vision_bundle.mjs';

const WASM_DIR = chrome.runtime.getURL('vendor/wasm');
const MODEL_URL = chrome.runtime.getURL('models/face_landmarker.task');

let landmarker = null;

export async function initLandmarker() {
  if (landmarker) return landmarker;
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
  const common = {
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true
  };
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      ...common
    });
  } catch (eGpu) {
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      ...common
    });
  }
  return landmarker;
}

export function detect(video, nowMs) {
  if (!landmarker) return null;
  try {
    return landmarker.detectForVideo(video, nowMs);
  } catch (_) {
    return null;
  }
}

// ---------- geometry helpers ----------
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) }; }
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}
function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }

// Head orientation from the face normal (works equally for yaw and pitch).
export function headPose(lm) {
  const rEye = lm[33], lEye = lm[263], top = lm[10], chin = lm[152];
  if (!rEye || !lEye || !top || !chin) return { yaw: 0, pitch: 0 };
  const across = sub(lEye, rEye); // right eye -> left eye (face X axis)
  const up = sub(top, chin);      // chin -> forehead (face Y axis)
  const n = cross(across, up);    // face normal
  const nz = Math.abs(n.z) < 1e-6 ? 1e-6 : Math.abs(n.z);
  const yaw = Math.atan2(n.x, nz) * 180 / Math.PI;
  const pitch = Math.atan2(n.y, nz) * 180 / Math.PI;
  return { yaw, pitch };
}

// Eye-gaze offset: iris position relative to each eye's center, normalized by
// eye size. Both eyes contribute with the same sign for a given gaze direction.
// Returns null if the model didn't produce iris landmarks (needs 478).
export function eyeGaze(lm) {
  if (!lm || lm.length < 478) return null;
  const rOut = lm[33], rIn = lm[133], rTop = lm[159], rBot = lm[145], rIris = lm[468];
  const lOut = lm[263], lIn = lm[362], lTop = lm[386], lBot = lm[374], lIris = lm[473];
  if (!rIris || !lIris) return null;

  const rcx = (rOut.x + rIn.x) / 2, rcy = (rTop.y + rBot.y) / 2;
  const lcx = (lOut.x + lIn.x) / 2, lcy = (lTop.y + lBot.y) / 2;
  const rw = Math.hypot(rIn.x - rOut.x, rIn.y - rOut.y) || 1e-6;
  const lw = Math.hypot(lIn.x - lOut.x, lIn.y - lOut.y) || 1e-6;
  const rh = (Math.abs(rBot.y - rTop.y)) || 1e-6;
  const lh = (Math.abs(lBot.y - lTop.y)) || 1e-6;

  const h = ((rIris.x - rcx) / rw + (lIris.x - lcx) / lw) / 2;
  const v = ((rIris.y - rcy) / rh + (lIris.y - lcy) / lh) / 2;
  return { h, v };
}

export class AttentionEngine {
  constructor() {
    this.cfg = {
      mode: 'head',          // 'head' | 'eyes'
      sensitivity: 3,
      pauseDelayMs: 90,      // near-instant pause
      resumeDelayMs: 220     // small delay to avoid flicker on resume
    };
    this.calib = { yaw: 0, pitch: 0, eyeH: 0, eyeV: 0 };
    this.away = false;
    this.candidate = null;
    this.candidateSince = 0;
    this.noFaceSince = 0;
    this._calReq = false;
    this._calN = 0;
    this._calAcc = { yaw: 0, pitch: 0, eyeH: 0, eyeV: 0 };
  }

  setConfig(c) { this.cfg = { ...this.cfg, ...c }; }

  requestCalibration() {
    this._calReq = true;
    this._calN = 0;
    this._calAcc = { yaw: 0, pitch: 0, eyeH: 0, eyeV: 0 };
  }

  thresholds() {
    const s = this.cfg.sensitivity;
    return {
      yawMax: [0, 30, 24, 19, 15, 11][s],
      pitchMax: [0, 22, 17, 14, 11, 8][s],
      eyeHMax: [0, 0.17, 0.14, 0.115, 0.09, 0.07][s],
      eyeVMax: [0, 0.14, 0.115, 0.095, 0.075, 0.06][s],
      noFaceGraceMs: [0, 700, 500, 350, 250, 150][s]
    };
  }

  process(now, result) {
    const faces = result && result.faceLandmarks ? result.faceLandmarks.length : 0;
    const hasFace = faces > 0;
    const lm = hasFace ? result.faceLandmarks[0] : null;

    let hp = { yaw: this.calib.yaw, pitch: this.calib.pitch };
    let eg = null;
    if (hasFace) {
      hp = headPose(lm);
      eg = eyeGaze(lm);

      if (this._calReq) {
        this._calAcc.yaw += hp.yaw;
        this._calAcc.pitch += hp.pitch;
        if (eg) { this._calAcc.eyeH += eg.h; this._calAcc.eyeV += eg.v; }
        this._calN++;
        if (this._calN >= 8) {
          this.calib.yaw = this._calAcc.yaw / this._calN;
          this.calib.pitch = this._calAcc.pitch / this._calN;
          this.calib.eyeH = this._calAcc.eyeH / this._calN;
          this.calib.eyeV = this._calAcc.eyeV / this._calN;
          this._calReq = false;
        }
      }
    }

    const dyaw = hp.yaw - this.calib.yaw;
    const dpitch = hp.pitch - this.calib.pitch;
    const deyeH = eg ? eg.h - this.calib.eyeH : 0;
    const deyeV = eg ? eg.v - this.calib.eyeV : 0;

    const T = this.thresholds();
    const eyesMode = this.cfg.mode === 'eyes';

    let wantAway;
    if (!hasFace) {
      if (this.noFaceSince === 0) this.noFaceSince = now;
      wantAway = (now - this.noFaceSince) >= T.noFaceGraceMs;
    } else {
      this.noFaceSince = 0;
      let headAway = Math.abs(dyaw) > T.yawMax || Math.abs(dpitch) > T.pitchMax;
      let eyeAway = false;
      if (eyesMode && eg) {
        eyeAway = Math.abs(deyeH) > T.eyeHMax || Math.abs(deyeV) > T.eyeVMax;
      }
      wantAway = headAway || eyeAway;
    }

    let awayChanged = false;
    if (wantAway !== this.away) {
      if (this.candidate !== wantAway) {
        this.candidate = wantAway;
        this.candidateSince = now;
      } else {
        const delay = wantAway ? this.cfg.pauseDelayMs : this.cfg.resumeDelayMs;
        if (now - this.candidateSince >= delay) {
          this.away = wantAway;
          this.candidate = null;
          awayChanged = true;
        }
      }
    } else {
      this.candidate = null;
    }

    return {
      hasFace,
      hasIris: !!eg,
      mode: this.cfg.mode,
      calibrating: this._calReq,
      yaw: round1(dyaw),
      pitch: round1(dpitch),
      eyeH: round3(deyeH),
      eyeV: round3(deyeV),
      away: this.away,
      awayChanged,
      thresholds: T
    };
  }
}
