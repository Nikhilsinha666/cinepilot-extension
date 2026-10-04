// permission.js — CinePilot's visible page that prompts for camera access.
// Once granted here, Chrome remembers the permission for the extension origin,
// so the hidden offscreen document can open the camera without a prompt.
//
// The stream is deliberately released again before notifying the background, so
// the offscreen detector can claim the device cleanly.

const askBtn = document.getElementById('askBtn');
const preview = document.getElementById('preview');
const msg = document.getElementById('msg');

let activeStream = null;

function setMsg(text, kind) {
  msg.textContent = text;
  msg.className = 'msg' + (kind ? ' ' + kind : '');
}

async function requestCamera() {
  askBtn.disabled = true;
  setMsg('Requesting camera…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    activeStream = stream;
    preview.srcObject = stream;
    preview.classList.add('show');
    setMsg('Camera enabled. Starting CinePilot…', 'ok');
    askBtn.textContent = 'Camera enabled ✓';

    // Show the preview briefly, then release this stream and notify the
    // background so the offscreen detector can open the camera cleanly.
    setTimeout(() => {
      if (activeStream) {
        activeStream.getTracks().forEach((t) => t.stop());
        activeStream = null;
        preview.classList.remove('show');
      }
      chrome.runtime.sendMessage({ t: 'permissionGranted' }).catch(() => {});
      setMsg('All set. You can close this tab — CinePilot is now active on YouTube.', 'ok');
    }, 1500);
  } catch (e) {
    askBtn.disabled = false;
    const name = e && e.name;
    if (name === 'NotAllowedError') {
      setMsg('Permission was blocked. Use the camera icon in the address bar to allow it, then try again.', 'err');
    } else if (name === 'NotFoundError') {
      setMsg('No camera was found on this device.', 'err');
    } else if (name === 'NotReadableError') {
      setMsg('The camera is being used by another app. Close it and try again.', 'err');
    } else {
      setMsg('Could not access the camera: ' + (e.message || name || 'unknown error'), 'err');
    }
  }
}

askBtn.addEventListener('click', requestCamera);

window.addEventListener('pagehide', () => {
  if (activeStream) activeStream.getTracks().forEach((t) => t.stop());
});
