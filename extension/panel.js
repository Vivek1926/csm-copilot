// Side panel UI: status, live hint, question cards (newest on top, nothing
// overwrites), manual "Ask this", transcript log, Stage-2 settings.

import { MSG, TARGET, request, broadcast } from './lib/messaging.js';
import { renderAnswerInto } from './lib/markdown.js';
import { AnswerClient } from './lib/answers.js';
import { buildSummaryPrompt } from './lib/summary.js';

const $ = (id) => document.getElementById(id);

const el = {
  statusDot: $('statusDot'),
  statusText: $('statusText'),
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
  cfgSttEngine: $('cfgSttEngine'),
  cfgDeepgramKey: $('cfgDeepgramKey'),
  cfgSttLanguage: $('cfgSttLanguage'),
  cfgSttModel: $('cfgSttModel'),
  cfgTerms: $('cfgTerms'),
  saveCfg: $('saveCfg'),
  cfgSaved: $('cfgSaved'),
};

let capturing = false;
let lastFinalText = '';

// Session accumulator for the post-call summary: every finalized utterance
// and detected question of the current capture session.
const session = {
  transcript: [],           // [{t, text}]
  questions: new Map(),     // questionId -> {q, answered}
  summaryDone: false,
  hasContent() {
    return this.transcript.length > 0 || this.questions.size > 0;
  },
  reset() {
    this.transcript = [];
    this.questions = new Map();
    this.summaryDone = false;
  },
};

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
  const wasCapturing = capturing;
  capturing = state === 'capturing' || state === 'loading-model' || state === 'starting';

  // Fresh capture session begins: clear the previous session's accumulator.
  if (state === 'starting') session.reset();
  // Capture just ended with content: generate the post-call summary card.
  if (wasCapturing && state === 'idle' && session.hasContent() && !session.summaryDone) {
    session.summaryDone = true;
    generateCallSummary();
  }

  el.statusDot.className = `dot ${state}`;
  el.statusText.textContent = STATE_LABELS[state] || state;
  el.toggleBtn.textContent = capturing ? 'Stop' : 'Start';
  el.toggleBtn.classList.toggle('primary', !capturing);

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

// Local fallback for "Ask this" when no capture session (offscreen doc) is
// running: the panel CAN read chrome.storage, so it renders the card and
// calls Astra directly. During capture, the offscreen detector handles it
// (with Stage-2 refinement + conversation context).
let localAnswerClient = null;
let localAskCounter = 0;

async function getAnswerClient() {
  const cfg = await chrome.storage.local.get(['astraBaseUrl', 'astraApiKey', 'answerPersonaId']);
  if (!localAnswerClient) localAnswerClient = new AnswerClient(() => cfg);
  localAnswerClient.configProvider = () => cfg; // fresh settings on every use
  return localAnswerClient;
}

async function localAsk(text) {
  const client = await getAnswerClient();

  const event = {
    questionId: `qlocal_${++localAskCounter}_${Date.now()}`,
    refinedQuery: text,
    originalUtterance: text,
    isQuestion: true,
    confidence: 0.9,
    topicTags: [],
    createdAt: new Date().toISOString(),
    trigger: 'manual',
  };
  renderQuestionCard(event);
  client.getAnswer(text, (result) =>
    renderAnswer({ questionId: event.questionId, ...result })
  );
}

// ---------------------------------------------------------------------------
// Post-call summary + follow-up email draft
// ---------------------------------------------------------------------------

let summaryCounter = 0;

async function generateCallSummary() {
  const prompt = buildSummaryPrompt(
    session.transcript,
    [...session.questions.values()]
  );

  const summaryId = `summary_${++summaryCounter}_${Date.now()}`;
  el.emptyFeed.hidden = true;

  const card = document.createElement('div');
  card.className = 'qcard summary-card';
  card.dataset.questionId = summaryId;

  const head = document.createElement('div');
  head.className = 'qhead';
  const icon = document.createElement('span');
  icon.className = 'summary-icon';
  icon.textContent = '📋';
  const title = document.createElement('div');
  title.className = 'query';
  title.textContent = 'Call Summary & Follow-up';
  head.appendChild(icon);
  head.appendChild(title);
  card.appendChild(head);

  const answer = document.createElement('div');
  answer.className = 'answer loading';
  answer.dir = 'auto';
  answer.textContent = '⏳ Summarizing the call… 0s';
  card.appendChild(answer);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = `${new Date().toLocaleTimeString()} · ${session.transcript.length} utterances · ${session.questions.size} questions`;
  meta.appendChild(time);

  let rawMarkdown = '';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'iconbtn';
  copyBtn.textContent = '📄 Copy';
  copyBtn.title = 'Copy summary + email as markdown';
  copyBtn.disabled = true;
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(rawMarkdown).catch(() => {});
    copyBtn.textContent = '✓ Copied';
    setTimeout(() => (copyBtn.textContent = '📄 Copy'), 1500);
  });
  meta.appendChild(copyBtn);

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'iconbtn';
  downloadBtn.textContent = '⬇ Download';
  downloadBtn.title = 'Download summary + email as a markdown file';
  downloadBtn.disabled = true;
  downloadBtn.addEventListener('click', () => {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const header = `# Call Summary — ${now.toLocaleString()}\n\n_${session.transcript.length} utterances · ${session.questions.size} questions detected_\n\n`;
    const blob = new Blob([header + rawMarkdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `call-summary_${stamp}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  meta.appendChild(downloadBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'iconbtn';
  dismissBtn.textContent = '✕';
  dismissBtn.title = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    clearAnswerTimer(summaryId);
    card.remove();
    if (!el.questionFeed.querySelector('.qcard')) el.emptyFeed.hidden = false;
  });
  meta.appendChild(dismissBtn);
  card.appendChild(meta);

  el.questionFeed.prepend(card); // above everything, including pinned cards

  const startedAt = Date.now();
  const intervalId = setInterval(() => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    answer.textContent = `⏳ Summarizing the call… ${s}s`;
  }, 1000);
  answerTimers.set(summaryId, { intervalId, startedAt });

  const client = await getAnswerClient();
  client.getAnswer(prompt, (result) => {
    clearAnswerTimer(summaryId);
    if (!card.isConnected) return; // dismissed while generating
    if (result.ok) {
      rawMarkdown = result.answer;
      answer.className = 'answer loaded';
      renderAnswerInto(answer, result.answer);
      copyBtn.disabled = false;
      downloadBtn.disabled = false;
    } else {
      answer.className = 'answer error';
      answer.textContent = `⚠ ${result.error}`;
    }
  });
}

async function manualAsk() {
  const text = el.manualText.value.trim() || lastFinalText;
  if (!text) return;
  el.manualText.value = '';

  // Prefer the offscreen detector (refinement + context). If it isn't
  // running (capture stopped), answer directly from the panel.
  const res = await request({ target: TARGET.OFFSCREEN, type: MSG.MANUAL_ASK, text }).catch(
    () => null
  );
  if (!res?.ok) await localAsk(text);
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
  session.transcript.push({ t: segment.startMs, text: segment.text });
  if (!el.manualText.value) el.manualText.placeholder = segment.text;

  const entry = document.createElement('div');
  entry.className = 'tentry';
  entry.dir = 'auto';
  const t = (segment.startMs / 1000).toFixed(0);
  const lang = segment.language ? ` · ${segment.language}` : '';
  entry.innerHTML = `<span class="tmeta">${t}s${lang}</span>`;
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

// Live per-card answer timers: count up while fetching, report total on load.
const answerTimers = new Map(); // questionId -> { intervalId, startedAt }

function clearAnswerTimer(questionId) {
  const timer = answerTimers.get(questionId);
  if (timer) {
    clearInterval(timer.intervalId);
    answerTimers.delete(questionId);
  }
  return timer;
}

// The ✅/⏳ chip on each card: reflects (and lets the consultant override)
// whether a question counts as answered — this feeds the call summary.
// On hover it previews the action a click will perform, so the flip never
// comes as a surprise.
function updateAnsweredToggle(btn, answered) {
  btn.dataset.answered = String(answered);
  btn.textContent = answered ? '✅ Answered' : '⏳ Follow-up';
  btn.classList.toggle('on', answered);
  btn.classList.toggle('off', !answered);
}

function renderQuestionCard(event) {
  el.emptyFeed.hidden = true;
  const entry = { q: event.refinedQuery, answered: false, manual: false };
  session.questions.set(event.questionId, entry);

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
  query.dir = 'auto'; // RTL languages (Arabic) render correctly
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

  const answeredBtn = document.createElement('button');
  answeredBtn.className = 'iconbtn answered-toggle';
  answeredBtn.title =
    'Toggle answered vs needs follow-up — this drives the ✅/⏳ list in the call summary';
  updateAnsweredToggle(answeredBtn, entry.answered);
  answeredBtn.addEventListener('click', () => {
    entry.answered = !entry.answered;
    entry.manual = true; // consultant's word beats the auto-inference
    updateAnsweredToggle(answeredBtn, entry.answered);
  });
  // Preview the click action on hover instead of silently flipping state.
  answeredBtn.addEventListener('mouseenter', () => {
    answeredBtn.textContent = entry.answered ? 'Mark ⏳ follow-up?' : 'Mark ✅ answered?';
  });
  answeredBtn.addEventListener('mouseleave', () => {
    updateAnsweredToggle(answeredBtn, entry.answered);
  });
  meta.appendChild(answeredBtn);

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
    clearAnswerTimer(event.questionId);
    card.remove();
    if (!el.questionFeed.querySelector('.qcard')) el.emptyFeed.hidden = false;
  });
  meta.appendChild(dismissBtn);
  card.appendChild(meta);

  // Answer area — filled asynchronously by ANSWER_UPDATE from Astra, with a
  // live elapsed-seconds counter while waiting.
  const answer = document.createElement('div');
  answer.className = 'answer loading';
  answer.dir = 'auto';
  answer.textContent = '⏳ Fetching answer… 0s';
  card.appendChild(answer);

  const startedAt = Date.now();
  const intervalId = setInterval(() => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    answer.textContent = `⏳ Fetching answer… ${s}s`;
  }, 1000);
  answerTimers.set(event.questionId, { intervalId, startedAt });

  // Insert: below pinned cards, above everything else.
  const firstUnpinned = el.questionFeed.querySelector('.qcard:not(.pinned)');
  el.questionFeed.insertBefore(card, firstUnpinned || el.emptyFeed);
}

function renderAnswer({ questionId, ok, answer, error }) {
  const entry = session.questions.get(questionId);
  // Auto-infer "answered" when Astra returns — unless the consultant has
  // already toggled it by hand.
  if (ok && entry && !entry.manual) entry.answered = true;

  const card = el.questionFeed.querySelector(
    `.qcard[data-question-id="${questionId}"]`
  );
  const timer = clearAnswerTimer(questionId);
  if (!card) return; // card was dismissed before the answer arrived
  const toggle = card.querySelector('.answered-toggle');
  if (toggle && entry) updateAnsweredToggle(toggle, entry.answered);
  const answerEl = card.querySelector('.answer');
  if (!answerEl) return;

  const elapsed = timer ? ((Date.now() - timer.startedAt) / 1000).toFixed(1) : null;

  if (ok) {
    answerEl.className = 'answer loaded';
    renderAnswerInto(answerEl, answer); // markdown + citations -> formatted DOM
    if (elapsed !== null) {
      const time = document.createElement('div');
      time.className = 'answer-time';
      time.textContent = `⚡ Answered in ${elapsed}s`;
      answerEl.prepend(time);
    }
  } else {
    answerEl.className = 'answer error';
    answerEl.textContent = `⚠ ${error}${elapsed !== null ? ` (after ${elapsed}s)` : ''}`;
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
    'sttEngine',
    'sttModel',
    'deepgramApiKey',
    'sttLanguage',
    'domainTerms',
  ]);
  el.cfgBaseUrl.value = cfg.astraBaseUrl || '';
  el.cfgApiKey.value = cfg.astraApiKey || '';
  el.cfgPersonaId.value = cfg.astraPersonaId || '';
  el.cfgAnswerPersonaId.value = cfg.answerPersonaId || '';
  el.cfgSttEngine.value = cfg.sttEngine || 'deepgram';
  el.cfgDeepgramKey.value = cfg.deepgramApiKey || '';
  // auto/en/hi/ar supported; older stored values (e.g. 'multi') map to auto.
  el.cfgSttLanguage.value = ['auto', 'en', 'hi', 'ar'].includes(cfg.sttLanguage)
    ? cfg.sttLanguage
    : 'auto';
  el.cfgSttModel.value = cfg.sttModel || 'onnx-community/whisper-small';
  el.cfgTerms.value = cfg.domainTerms || '';
}

async function saveSettings() {
  const config = {
    astraBaseUrl: el.cfgBaseUrl.value.trim(),
    astraApiKey: el.cfgApiKey.value.trim(),
    astraPersonaId: el.cfgPersonaId.value.trim(),
    answerPersonaId: el.cfgAnswerPersonaId.value.trim(),
    sttEngine: el.cfgSttEngine.value,
    deepgramApiKey: el.cfgDeepgramKey.value.trim(),
    sttLanguage: el.cfgSttLanguage.value,
    sttModel: el.cfgSttModel.value,
    domainTerms: el.cfgTerms.value.trim(),
  };
  await chrome.storage.local.set(config);
  // Push to a running capture session too — the offscreen doc can't read
  // chrome.storage itself.
  broadcast({ target: TARGET.OFFSCREEN, type: MSG.CONFIG_UPDATE, config });
  el.cfgSaved.hidden = false;
  setTimeout(() => (el.cfgSaved.hidden = true), 1500);
}

el.saveCfg.addEventListener('click', saveSettings);
// Language/engine dropdowns apply immediately — forgetting to press Save
// silently leaves the wrong STT language active (e.g. Arabic speech being
// force-fitted to Hindi/English by 'multi' mode).
el.cfgSttLanguage.addEventListener('change', saveSettings);
el.cfgSttEngine.addEventListener('change', saveSettings);

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
