// Offscreen document: the audio engine. Receives the tabCapture streamId,
// holds the MediaStream, re-pipes audio to the speakers (tabCapture mutes the
// tab otherwise), downsamples to 16 kHz mono, VAD-segments into utterances,
// runs Whisper in a worker, and feeds finalized utterances to the question
// detector (Part B). Emits TranscriptSegment + QuestionEvent to the panel.

import { MSG, TARGET, broadcast } from './lib/messaging.js';
import { VAD } from './vad.js';
import { QuestionDetector } from './lib/detector.js';
import { Stage2Client } from './lib/stage2.js';
import { AnswerClient } from './lib/answers.js';
import { createCorrector, DEFAULT_TERMS } from './lib/lexicon.js';
import { DeepgramClient, keywordsFromTerms } from './lib/deepgram.js';

let stream = null;
let playbackCtx = null; // default rate, source -> destination (so the call stays audible)
let captureCtx = null;  // 16 kHz, source -> worklet -> VAD
let worker = null;
let vad = null;
let detector = null;
let capturing = false;
let whisperReady = false;
let segCounter = 0;
const pendingSegments = new Map(); // whisper job id -> { startMs, endMs }
// Config, pushed in via messages (offscreen docs can't read chrome.storage —
// only chrome.runtime is available here). Holds Stage-2 creds, STT engine
// choice, and extra domain terms.
let config = {};
let correctTerms = createCorrector(DEFAULT_TERMS);
let allTerms = [...DEFAULT_TERMS];

function applyConfig(cfg) {
  config = cfg || {};
  const extra = String(config.domainTerms || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  allTerms = [...DEFAULT_TERMS, ...extra];
  correctTerms = createCorrector(allTerms);
}

// STT engine: 'deepgram' (cloud, default) or 'whisper' (local, offline).
let sttEngine = 'deepgram';
let dgClient = null;
let dgQueue = Promise.resolve(); // serialize so transcript order is preserved

function sendStatus(partial) {
  broadcast({ target: TARGET.PANEL, type: MSG.STATUS, capturing, whisperReady, ...partial });
}

// ---------------------------------------------------------------------------
// Whisper worker management
// ---------------------------------------------------------------------------

function initWhisperWorker(modelId) {
  if (worker) return;
  worker = new Worker('whisper-worker.js', { type: 'module' });

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      broadcast({ target: TARGET.PANEL, type: MSG.MODEL_PROGRESS, ...msg });
    } else if (msg.type === 'ready') {
      whisperReady = true;
      sendStatus({ state: 'capturing', device: msg.device });
    } else if (msg.type === 'result') {
      onSttResult(msg);
    } else if (msg.type === 'error') {
      sendStatus({ state: 'error', error: msg.error });
    }
  };

  worker.postMessage({ type: 'init', modelId: modelId || undefined });
}

function sttDeviceLabel() {
  const pair = ['en-hi', 'en-ar'].includes(config.sttLanguage)
    ? config.sttLanguage
    : 'en-hi';
  return `deepgram · ${pair.toUpperCase()}`;
}

function initSttEngine() {
  sttEngine = config.sttEngine === 'whisper' ? 'whisper' : 'deepgram';
  if (sttEngine === 'deepgram') {
    dgClient = new DeepgramClient(() => config);
    whisperReady = true; // no model download — ready immediately
    sendStatus({ state: 'capturing', device: sttDeviceLabel() });
  } else {
    initWhisperWorker(config.sttModel);
  }
}

function transcribeSegment(id, audio) {
  if (sttEngine === 'deepgram') {
    // Serialized so segments reach the detector in spoken order.
    dgQueue = dgQueue.then(async () => {
      const t0 = performance.now();
      try {
        const r = await dgClient.transcribe(audio, keywordsFromTerms(allTerms));
        onSttResult({ id, text: r.text, language: r.language, sttMs: Math.round(performance.now() - t0) });
      } catch (err) {
        onSttResult({ id, error: String(err?.message || err) });
        sendStatus({ error: `Deepgram: ${String(err?.message || err)}` });
      }
    });
  } else {
    worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  }
}

// Whisper-base hallucinates annotations on non-speech audio: "[BLANK_AUDIO]",
// "[inaudible]", "(electronic music)", "[Music]", "♪", and degenerate word
// loops ("No. No. No. ..."). Strip/drop these before anything downstream
// sees them — a hallucinated utterance in the context window poisons Stage 2.
function cleanTranscript(raw) {
  const text = raw
    .replace(/\[[^\]]*\]/g, ' ')  // [inaudible], [BLANK_AUDIO], [Music]…
    .replace(/\([^)]*\)/g, ' ')   // (electronic music), (laughter)…
    .replace(/[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  // Repetition-loop guard: if one word dominates a long utterance, it's noise.
  const words = text.toLowerCase().replace(/[^a-z0-9'\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length >= 8) {
    const counts = new Map();
    let max = 0;
    for (const w of words) {
      const c = (counts.get(w) || 0) + 1;
      counts.set(w, c);
      if (c > max) max = c;
    }
    if (max / words.length > 0.5) return null;
  }
  return text;
}

function onSttResult({ id, text, error, sttMs, language }) {
  const meta = pendingSegments.get(id);
  pendingSegments.delete(id);
  broadcast({ target: TARGET.PANEL, type: MSG.INTERIM_HINT, speaking: false, transcribing: pendingSegments.size > 0 });
  if (!meta || error || !text) return;

  let cleaned = cleanTranscript(text);
  if (!cleaned) return; // pure hallucination/noise — drop silently
  // Fix misheard domain terms ("secular online" -> "Seclore Online") before
  // the panel or the detector sees the text.
  cleaned = correctTerms(cleaned);

  const segment = {
    id,
    text: cleaned,
    isFinal: true,
    speechFinal: true,
    speaker: 'unknown', // diarization is post-MVP; Stage-2 prompt tolerates this
    startMs: meta.startMs,
    endMs: meta.endMs,
    confidence: null, // Whisper pipeline doesn't expose a usable per-utterance score
    sttMs,
    language: language || null, // which language this utterance was heard in
  };

  broadcast({ target: TARGET.PANEL, type: MSG.TRANSCRIPT_SEGMENT, segment });
  detector?.onFinalUtterance(segment);
}

// ---------------------------------------------------------------------------
// Capture lifecycle
// ---------------------------------------------------------------------------

async function startCapture(streamId, cfg) {
  if (capturing) return;
  capturing = true;
  if (cfg) applyConfig(cfg);
  sendStatus({ state: 'starting' });

  initSttEngine();

  // Retrieval layer: each detected question is answered by the Astra
  // knowledge persona; the answer streams into the question's card.
  const answers = new AnswerClient(() => config);

  detector = new QuestionDetector({
    emit: (event) => {
      broadcast({ target: TARGET.PANEL, type: MSG.QUESTION_EVENT, event });
      answers.getAnswer(event.refinedQuery, (result) =>
        broadcast({
          target: TARGET.PANEL,
          type: MSG.ANSWER_UPDATE,
          questionId: event.questionId,
          ...result,
        })
      );
    },
    onInfo: (info) => broadcast({ target: TARGET.PANEL, type: MSG.STATUS, capturing, whisperReady, detector: info }),
    stage2: new Stage2Client(() => config),
  });

  // Redeem the streamId for the real tab-audio MediaStream (legacy constraint
  // syntax is required for the chromeMediaSource flow).
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  // Critical: tabCapture mutes the tab for the user. Re-pipe to the speakers
  // at the native rate so the consultant can still hear the call.
  playbackCtx = new AudioContext();
  playbackCtx.createMediaStreamSource(stream).connect(playbackCtx.destination);

  // Separate 16 kHz context for STT — Chrome resamples the stream for us,
  // and the call audio above stays at full quality.
  captureCtx = new AudioContext({ sampleRate: 16000 });
  await captureCtx.audioWorklet.addModule('audio-worklet.js');
  const workletNode = new AudioWorkletNode(captureCtx, 'pcm-frames');
  captureCtx.createMediaStreamSource(stream).connect(workletNode);

  vad = new VAD({
    sampleRate: 16000,
    onSpeechStart: () =>
      broadcast({ target: TARGET.PANEL, type: MSG.INTERIM_HINT, speaking: true }),
    onSegment: (audio, startMs, endMs) => {
      const id = `seg_${String(++segCounter).padStart(4, '0')}`;
      pendingSegments.set(id, { startMs, endMs });
      broadcast({ target: TARGET.PANEL, type: MSG.INTERIM_HINT, speaking: false, transcribing: true });
      transcribeSegment(id, audio);
    },
  });

  workletNode.port.onmessage = (e) => vad.push(e.data);

  // If the user stops sharing / closes the tab, tear down cleanly.
  stream.getAudioTracks()[0]?.addEventListener('ended', stopCapture);

  sendStatus({ state: whisperReady ? 'capturing' : 'loading-model' });
}

function stopCapture() {
  if (!capturing) return;
  capturing = false;
  vad?.flush();
  stream?.getTracks().forEach((t) => t.stop());
  playbackCtx?.close().catch(() => {});
  captureCtx?.close().catch(() => {});
  stream = playbackCtx = captureCtx = vad = null;
  sendStatus({ state: 'idle' });
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== TARGET.OFFSCREEN) return false;

  if (msg.type === MSG.CONFIG_UPDATE) {
    applyConfig(msg.config);
    // Refresh the panel's language badge so the active STT language is
    // always visible (wrong-language transcripts look like garbling).
    if (capturing && sttEngine === 'deepgram') {
      sendStatus({ state: whisperReady ? 'capturing' : 'loading-model', device: sttDeviceLabel() });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === MSG.START_CAPTURE) {
    startCapture(msg.streamId, msg.config)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        capturing = false;
        sendStatus({ state: 'error', error: String(err?.message || err) });
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }

  if (msg.type === MSG.STOP_CAPTURE) {
    stopCapture();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === MSG.MANUAL_ASK) {
    detector?.manualAsk(msg.text);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === MSG.GET_STATE) {
    sendResponse({
      capturing,
      whisperReady,
      state: capturing ? (whisperReady ? 'capturing' : 'loading-model') : 'idle',
    });
    return false;
  }

  return false;
});
