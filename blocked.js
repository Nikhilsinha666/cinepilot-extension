// blocked.js — the interstitial a blocked navigation lands on.
//
// Deliberately never a dead end: there is always a way back to the video and a
// one-click way to turn the whole mode off. A focus tool that traps you is just
// a broken browser.

const params = new URLSearchParams(location.search);
const reason = params.get('r') || 'hyperfocus';
const blockedUrl = params.get('u') || '';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

const COPY = {
  hyperfocus: {
    title: 'Hyper Focus is on',
    lead: 'You picked one video to watch. Everything else is closed off until you turn it back on.',
    hint: 'Sites on your allowlist stay reachable. chrome:// pages are never blocked, so you can always get to your settings.'
  },
  'left-video': {
    title: 'That is a different video',
    lead: 'Hyper Focus keeps this tab on the video you started with. Following a recommendation is exactly the thing it exists to stop.',
    hint: 'Turn Hyper Focus off if you actually want to switch, then turn it back on to lock in the new video.'
  },
  blocklist: {
    title: 'On your blocklist',
    lead: 'You added this site to your blocklist, so CinePilot blocks it whether Hyper Focus is on or not.',
    hint: 'Edit the list any time from the extension options.'
  }
};

const copy = COPY[reason] || COPY.hyperfocus;
$('title').textContent = copy.title;
$('lead').textContent = copy.lead;
$('hint').textContent = copy.hint;

// Show the blocked URL, but never render it as a clickable link: the whole point
// is that this destination is off limits right now.
if (blockedUrl) {
  try {
    const u = new URL(blockedUrl);
    $('target').textContent = u.hostname.replace(/^www\./, '') + u.pathname + (u.search || '');
  } catch (_) {
    $('target').textContent = blockedUrl;
  }
}

// A blocklist hit is not about Hyper Focus, so do not offer to turn that off.
if (reason === 'blocklist') {
  $('offBtn').textContent = 'Open blocklist settings';
  $('offBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage ? chrome.runtime.openOptionsPage()
                                   : chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  });
} else {
  $('offBtn').addEventListener('click', async () => {
    $('offBtn').disabled = true;
    const res = await send({ t: 'hyperFocus', value: false });
    if (res && res.ok === false) {
      // The commitment lock is holding. Say so here rather than pretending the
      // button did something.
      $('offBtn').disabled = false;
      $('offBtn').textContent = 'Still locked';
      $('hint').textContent = res.locked
        ? `You committed to watching ${res.need}% of the video first, and you are at ${res.percent}%. Keep watching, or close the tab to end the session.`
        : (res.error || 'Could not switch Hyper Focus off.');
      return;
    }
    await send({ t: 'gotoFocused' });
    history.length > 1 ? history.back() : window.close();
  });
}

const backBtn = $('backBtn');
send({ t: 'focusedTab' }).then((res) => {
  if (!res || res.tabId == null) {
    backBtn.textContent = 'Go to YouTube';
    backBtn.addEventListener('click', () => { location.href = 'https://www.youtube.com/'; });
    return;
  }
  backBtn.addEventListener('click', async () => {
    await send({ t: 'gotoFocused' });
    // This tab was hijacked from somewhere; give it back if we can.
    if (history.length > 1) history.back();
  });
});
