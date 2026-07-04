// Side panel UI: status, live hint, question cards (newest on top, nothing
// overwrites), manual "Ask this", transcript log, Stage-2 settings.

import { MSG, TARGET, request, broadcast } from './lib/messaging.js';
import { renderAnswerInto } from './lib/markdown.js';

const $ = (id) => document.getElementById(id);

const el = {
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  deviceBadge: $('deviceBadge'),
  latencyBadge: $('latencyBadge'),
  toggleBtn: $('toggleBtn'),
  modelProgress: $('modelProgress'),
  progressPct: $('progressPct'),
  progressFill: $('progressFill'),
  banner: $('banner'),
  liveHint: $('liveHint'),
  hintText: $('hintText'),
  manualText: $('manualText'),
  askBtn: $('askBtn'),
  questionFeed: $('questionFeed'),
  emptyFeed: $('emptyFeed'),
  transcriptEntries: $('transcriptEntries'),
  cfgBaseUrl: $('cfgBaseUrl'),
  cfgApiKey: $('cfgApiKey'),
  cfgPersonaId: $('cfgPersonaId'),
  cfgAnswerPersonaId: $('cfgAnswerPersonaId'),
  cfgSttModel: $('cfgSttModel'),
  cfgTerms: $('cfgTerms'),
  saveCfg: $('saveCfg'),
  cfgSaved: $('cfgSaved'),
};

let capturing = false;
let lastFinalText = '';

const STATE_LABELS = {
  idle: 'Idle',
  starting: 'Starting…',
  'loading-model': 'Loading model…',
  capturing: 'Capturing',
  error: 'Error',
};

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

el.toggleBtn.addEventListener('click', async () => {
  if (capturing) {
    await request({ target: TARGET.BACKGROUND, type: MSG.PANEL_STOP }).catch(() => {});
    setState('idle');
    return;
  }

  hideBanner();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return showBanner('No active tab found.');
  if (!tab.url?.startsWith('https://meet.google.com/')) {
    return showBanner('Open a Google Meet call tab first, then press Start.');
  }

  setState('starting');
  const res = await request({
    target: TARGET.BACKGROUND,
    type: MSG.PANEL_START,
    tabId: tab.id,
  }).catch((err) => ({ ok: false, error: String(err?.message || err) }));

  if (!res?.ok) {
    setState('idle');
    // tabCapture only works inside the toolbar-icon click gesture; this
    // Start button can't provide that. The icon click starts capture itself.
    if (/has not been invoked|activeTab|user gesture/i.test(res?.error || '')) {
      showBanner(
        'Start from the toolbar instead: focus the Meet tab and click the ' +
          'Pre-Sales Co-Pilot icon — that click is what lets Chrome capture ' +
          'the tab, and it starts the co-pilot directly.'
      );
    } else {
      setState('error');
      showBanner(`Could not start capture: ${res?.error || 'unknown error'}`);
    }
  }
});

function setState(state, extra = {}) {
  capturing = state === 'capturing' || state === 'loading-model' || state === 'starting';
  el.statusDot.className = `dot ${state}`;
  el.statusText.textContent = STATE_LABELS[state] || state;
  el.toggleBtn.textContent = capturing ? 'Stop' : 'Start';
  el.toggleBtn.classList.toggle('primary', !capturing);

  if (extra.device) {
    el.deviceBadge.textContent = extra.device.toUpperCase();
    el.deviceBadge.hidden = false;
  }
  if (state === 'idle') {
    el.hintText.textContent = 'Not capturing';
    el.liveHint.className = 'live-hint';
    el.modelProgress.hidden = true;
  }
}

function showBanner(text) {
  el.banner.textContent = text;
  el.banner.hidden = false;
}
function hideBanner() {
  el.banner.hidden = true;
}

// ---------------------------------------------------------------------------
// Manual "Ask this"
// ---------------------------------------------------------------------------

function manualAsk() {
  const text = el.manualText.value.trim() || lastFinalText;
  if (!text) return;
  broadcast({ target: TARGET.OFFSCREEN, type: MSG.MANUAL_ASK, text });
  el.manualText.value = '';
}
el.askBtn.addEventListener('click', manualAsk);
el.manualText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') manualAsk();
});

// ---------------------------------------------------------------------------
// Incoming messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== TARGET.PANEL) return;

  switch (msg.type) {
    case MSG.STATUS:
      if (msg.state) setState(msg.state, msg);
      if (msg.error) showBanner(msg.error);
      break;

    case MSG.MODEL_PROGRESS:
      renderModelProgress(msg);
      break;

    case MSG.INTERIM_HINT:
      renderHint(msg);
      break;

    case MSG.TRANSCRIPT_SEGMENT:
      renderTranscript(msg.segment);
      break;

    case MSG.QUESTION_EVENT:
      renderQuestionCard(msg.event);
      break;

    case MSG.ANSWER_UPDATE:
      renderAnswer(msg);
      break;
  }
});

function renderModelProgress({ status, progress }) {
  if (status === 'progress' && typeof progress === 'number') {
    el.modelProgress.hidden = false;
    el.progressPct.textContent = `${Math.round(progress)}%`;
    el.progressFill.style.width = `${progress}%`;
  } else if (status === 'done' || status === 'ready') {
    el.modelProgress.hidden = true;
  }
}

function renderHint({ speaking, transcribing }) {
  if (speaking) {
    el.liveHint.className = 'live-hint speaking';
    el.hintText.textContent = 'Speaking…';
  } else if (transcribing) {
    el.liveHint.className = 'live-hint transcribing';
    el.hintText.textContent = 'Transcribing…';
  } else {
    el.liveHint.className = 'live-hint';
    el.hintText.textContent = 'Listening';
  }
}

function renderTranscript(segment) {
  lastFinalText = segment.text;
  if (!el.manualText.value) el.manualText.placeholder = segment.text;

  if (segment.sttMs != null) {
    el.latencyBadge.textContent = `stt ${(segment.sttMs / 1000).toFixed(1)}s`;
    el.latencyBadge.hidden = false;
  }

  const entry = document.createElement('div');
  entry.className = 'tentry';
  const t = (segment.startMs / 1000).toFixed(0);
  entry.innerHTML = `<span class="tmeta">${t}s</span>`;
  entry.appendChild(document.createTextNode(segment.text));
  el.transcriptEntries.prepend(entry);
  while (el.transcriptEntries.children.length > 12) {
    el.transcriptEntries.lastChild.remove();
  }
}

// ---------------------------------------------------------------------------
// Question cards — newest on top, independent, never overwritten.
// Pinned cards stay above unpinned ones.
// ---------------------------------------------------------------------------

function renderQuestionCard(event) {
  el.emptyFeed.hidden = true;

  const card = document.createElement('div');
  card.className = 'qcard';
  card.dataset.questionId = event.questionId;

  const confClass =
    event.confidence >= 0.75 ? 'high' : event.confidence >= 0.5 ? 'mid' : 'low';

  const head = document.createElement('div');
  head.className = 'qhead';
  head.innerHTML = `<span class="conf ${confClass}" title="confidence ${event.confidence}"></span>`;
  const query = document.createElement('div');
  query.className = 'query';
  query.textContent = event.refinedQuery;
  head.appendChild(query);
  card.appendChild(head);

  if (event.originalUtterance && event.originalUtterance !== event.refinedQuery) {
    const orig = document.createElement('div');
    orig.className = 'original';
    orig.textContent = `heard: "${event.originalUtterance}"`;
    card.appendChild(orig);
  }

  if (event.topicTags?.length || event.stage2Fallback || event.trigger === 'manual') {
    const tags = document.createElement('div');
    tags.className = 'tags';
    for (const tag of event.topicTags || []) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = tag;
      tags.appendChild(t);
    }
    if (event.trigger === 'manual') {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = 'manual';
      tags.appendChild(t);
    }
    if (event.stage2Fallback) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = 'unrefined';
      t.title = 'No Stage-2 LLM configured/reachable — raw utterance used as query';
      tags.appendChild(t);
    }
    card.appendChild(tags);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(event.createdAt).toLocaleTimeString();
  meta.appendChild(time);

  const pinBtn = document.createElement('button');
  pinBtn.className = 'iconbtn';
  pinBtn.textContent = '📌';
  pinBtn.title = 'Pin';
  pinBtn.addEventListener('click', () => {
    card.classList.toggle('pinned');
    reorderFeed();
  });
  meta.appendChild(pinBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'iconbtn';
  dismissBtn.textContent = '✕';
  dismissBtn.title = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    card.remove();
    if (!el.questionFeed.querySelector('.qcard')) el.emptyFeed.hidden = false;
  });
  meta.appendChild(dismissBtn);
  card.appendChild(meta);

  // Answer area — filled asynchronously by ANSWER_UPDATE from Astra.
  const answer = document.createElement('div');
  answer.className = 'answer loading';
  answer.textContent = '⏳ Fetching answer…';
  card.appendChild(answer);

  // Insert: below pinned cards, above everything else.
  const firstUnpinned = el.questionFeed.querySelector('.qcard:not(.pinned)');
  el.questionFeed.insertBefore(card, firstUnpinned || el.emptyFeed);
}

function renderAnswer({ questionId, ok, answer, error }) {
  const card = el.questionFeed.querySelector(
    `.qcard[data-question-id="${questionId}"]`
  );
  if (!card) return; // card was dismissed before the answer arrived
  const answerEl = card.querySelector('.answer');
  if (!answerEl) return;
  if (ok) {
    answerEl.className = 'answer loaded';
    renderAnswerInto(answerEl, answer); // markdown + citations -> formatted DOM
  } else {
    answerEl.className = 'answer error';
    answerEl.textContent = `⚠ ${error}`;
  }
}

function reorderFeed() {
  const pinned = [...el.questionFeed.querySelectorAll('.qcard.pinned')];
  for (const card of pinned.reverse()) {
    el.questionFeed.prepend(card);
  }
}

// ---------------------------------------------------------------------------
// Settings (Stage-2 LLM)
// ---------------------------------------------------------------------------

async function loadSettings() {
  const cfg = await chrome.storage.local.get([
    'astraBaseUrl',
    'astraApiKey',
    'astraPersonaId',
    'answerPersonaId',
    'sttModel',
    'domainTerms',
  ]);
  el.cfgBaseUrl.value = cfg.astraBaseUrl || '';
  el.cfgApiKey.value = cfg.astraApiKey || '';
  el.cfgPersonaId.value = cfg.astraPersonaId || '';
  el.cfgAnswerPersonaId.value = cfg.answerPersonaId || '';
  el.cfgSttModel.value = cfg.sttModel || 'onnx-community/whisper-small';
  el.cfgTerms.value = cfg.domainTerms || '';
}

el.saveCfg.addEventListener('click', async () => {
  const config = {
    astraBaseUrl: el.cfgBaseUrl.value.trim(),
    astraApiKey: el.cfgApiKey.value.trim(),
    astraPersonaId: el.cfgPersonaId.value.trim(),
    answerPersonaId: el.cfgAnswerPersonaId.value.trim(),
    sttModel: el.cfgSttModel.value,
    domainTerms: el.cfgTerms.value.trim(),
  };
  await chrome.storage.local.set(config);
  // Push to a running capture session too — the offscreen doc can't read
  // chrome.storage itself.
  broadcast({ target: TARGET.OFFSCREEN, type: MSG.CONFIG_UPDATE, config });
  el.cfgSaved.hidden = false;
  setTimeout(() => (el.cfgSaved.hidden = true), 1500);
});

loadSettings();
setState('idle');

// Capture may already be running (or starting) when the panel opens — the
// toolbar-icon click starts capture before this page finishes loading.
request({ target: TARGET.OFFSCREEN, type: MSG.GET_STATE })
  .then((state) => {
    if (state?.state) setState(state.state);
  })
  .catch(() => {
    /* no offscreen doc — stay idle */
  });
