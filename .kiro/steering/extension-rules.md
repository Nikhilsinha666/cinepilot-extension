# Architecture & Extension Guidelines for CinePilot

## 1. Chrome Offscreen API Architecture
- Offscreen documents must be created dynamically when playback begins and torn down when idle to conserve system RAM and GPU resources.
- Message passing between background service worker and offscreen document must use typed JSON events.

## 2. Gaze Detection Smoothing
- Raw frame-by-frame gaze classifications contain natural saccades and blinks. Always apply exponential moving average or rolling window buffers before triggering pause events.

## 3. Privacy Standards
- Zero raw camera frames may be saved to disk or transmitted over the network.
- Display visible indicator badge whenever camera feed is actively listening.
