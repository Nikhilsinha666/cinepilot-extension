# CinePilot for YouTube Specification Document

## 1. Product Overview
CinePilot is an intelligent deep-work video cinema extension for YouTube (Manifest V3). It delivers distraction-free learning by auto-fullscreening video playback, auto-pausing when the user glances away from the screen using local webcam gaze detection in an Offscreen document, and isolating video content from surrounding clutter in Hyper Focus mode.

## 2. Architecture & State Machine
- **Playback Interception**: Injects lightweight player hooks into YouTube HTML5 video elements.
- **Offscreen ML Inference**: Uses Chrome Offscreen API to run MediaPipe/TensorFlow face and gaze detection without exceeding service worker execution lifespans.
- **Smoothing Buffer & State Deadband**: Smooths gaze confidence scores over a 1,200ms rolling window to prevent spurious pause/play flickering.
- **Hyper Focus DOM Masking**: Masks comments, recommendations, chat, and headers into high-contrast focus dark mode.

## 3. Requirements Specification (EARS Notation)
- **REQ-1 (Auto-Fullscreen)**: WHEN a video begins playback in active study mode THE SYSTEM SHALL request fullscreen mode on the video container element.
- **REQ-2 (Gaze Loss Pause)**: WHEN facial presence or gaze confidence drops below 0.65 for more than 1,200 consecutive milliseconds THE SYSTEM SHALL pause video playback.
- **REQ-3 (Gaze Resume)**: WHEN facial presence is re-established centered in the webcam bounding box THE SYSTEM SHALL resume video playback smoothly.
- **REQ-4 (Hyper Focus Isolation)**: WHILE Hyper Focus mode is enabled THE SYSTEM SHALL mask all non-video DOM elements (sidebar recommendations, comments, ads).
- **REQ-5 (Offscreen Document Lifecycle)**: WHEN video playback ends or the tab closes THE SYSTEM SHALL gracefully close the offscreen document and release camera hardware locks.
- **REQ-6 (Zero Video Telemetry)**: WHILE webcam analysis is performed THE SYSTEM SHALL process all video frames strictly in volatile offscreen memory without network transmission.
