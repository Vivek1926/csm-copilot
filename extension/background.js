// Service worker: orchestration only. Mints the tabCapture streamId, manages
// the offscreen document lifecycle, routes control messages. Holds NO media,
// NO sockets, NO long-lived state (MV3 may kill it at any time).

import { MSG, TARGET, broadcast } from './lib/messaging.js';

const OFFSCREEN_URL = 'offscreen.html';

// The toolbar-icon click is our ONLY reliable "invocation" gesture: Chrome
// grants tabCapture on a tab exclusively through it (see tabCapture docs /
// activeTab). openPanelOnActionClick would swallow action.onClicked, so it
// must stay OFF — the setting persists in the profile, so clear it on every
// SW start, not just onInstalled.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// One click on the icon = open the panel + (on a Meet tab) start capture.
// getMediaStreamId must run inside this gesture; a Start button in the panel
// can't provide that, which is why capture starts here.
chrome.action.onClicked.addListener((tab) => {
  // Must be called synchronously within the gesture.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});

  if (tab.url?.startsWith('https://meet.google.com/')) {
    startCapture(tab.id).catch((err) => {
      console.error('startCapture failed', err);
      broadcast({
        target: TARGET.PANEL,
        type: MSG.STATUS,
        capturing: false,
        state: 'error',
        error: `Could not start capture: ${String(err?.message || err)}`,
      });
    });
  } else {
    broadcast({
      target: TARGET.PANEL,
      type: MSG.STATUS,
      capturing: false,
      state: 'idle',
      error: 'Open a Google Meet call tab, then click the toolbar icon again to start.',
    });
  }
});

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification:
      'Hold the tab-audio MediaStream and run local speech-to-text for the co-pilot.',
  });
}

async function startCapture(tabId) {
  // 1. Mint an opaque streamId for the target tab (this is a token, not a
  //    stream). MUST be the first call — it consumes the icon-click gesture.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  // 2. Make sure the offscreen document (the audio engine) exists.
  await ensureOffscreenDocument();
  // 3. Hand over the token plus the Stage-2 config (offscreen docs cannot
  //    read chrome.storage themselves).
  const config = await chrome.storage.local.get([
    'astraBaseUrl',
    'astraApiKey',
    'astraPersonaId',
    'answerPersonaId',
    'sttEngine',
    'sttModel',
    'deepgramApiKey',
    'sttLanguage',
    'domainTerms',
  ]);
  await chrome.runtime.sendMessage({
    target: TARGET.OFFSCREEN,
    type: MSG.START_CAPTURE,
    streamId,
    config,
  });
}

async function stopCapture() {
  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, type: MSG.STOP_CAPTURE });
    } catch {
      /* offscreen may already be gone */
    }
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  broadcast({ target: TARGET.PANEL, type: MSG.STATUS, capturing: false, state: 'idle' });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== TARGET.BACKGROUND) return false;

  if (msg.type === MSG.PANEL_START) {
    startCapture(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('startCapture failed', err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true; // async response
  }

  if (msg.type === MSG.PANEL_STOP) {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  return false;
});
