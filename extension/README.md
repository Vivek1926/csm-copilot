# Pre-Sales Co-Pilot — Chrome Extension (Parts A + B)

Live technical-question detection for Google Meet calls. Captures the meeting
tab's audio, transcribes it **locally** with Whisper (WebGPU, no audio leaves
the machine), gates utterances through a two-stage question detector, and
emits `QuestionEvent`s into the side panel — where the (separate) retrieval
layer will attach answers.

**Scope:** audio → STT → question detection → `QuestionEvent` → **answer
retrieval via the Astra chat API** (`lib/answers.js`, the flow prototyped in
`test.py`: create-chat-session once, send-chat-message per question, render
`answer_citationless`). Answers appear inside each question card.

> **Just want to use it?** See **[USAGE.md](USAGE.md)** — the step-by-step
> guide for consultants (setup, on-call workflow, troubleshooting). This
> README covers architecture and development.

## Install (unpacked)

1. Chrome 113+ on a **WebGPU-capable machine** (check `chrome://gpu`). The
   WASM fallback works but may not keep up with real-time.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select this `extension/` directory.
3. Open a Google Meet call and, with that tab focused, click the extension
   icon — this opens the side panel **and starts capture**. (Chrome only
   permits `tabCapture` from the toolbar-click gesture, so capture must start
   there; the panel's Start button only works for restarts on the same page.)

First start downloads `onnx-community/whisper-base` (~75 MB) from the
Hugging Face CDN and caches it in the browser. **Pre-warm before the demo**:
click the icon once on any Meet tab and let the progress bar finish — every
run after that is offline.

## Stage-2 LLM (optional but recommended)

Question classification + query refinement uses the Seclore **Astra** chat
API. Open the panel's *Settings* section and paste your Astra API key
(persona ID defaults to 3). The key lives in `chrome.storage.local` only —
never in the source.

Without a key the pipeline degrades gracefully: Stage-1 heuristic hits are
emitted directly with the raw utterance as the query, tagged **unrefined**.
The demo works either way.

## Architecture (why four parts)

MV3: the service worker has no DOM/`getUserMedia` and can be killed anytime;
`tabCapture` can't start from a content script; long-lived media needs a real
document → an **offscreen document** holds everything stateful.

```
toolbar-icon click ──▶ background (SW) action.onClicked:
 (the only gesture         │  opens side panel, mints tabCapture streamId,
  Chrome accepts for       │  creates offscreen doc
  tabCapture)              ▼
                     offscreen document
                       getUserMedia(streamId)
                       ├─ playback AudioContext → speakers   (tabCapture mutes
                       │                                      the tab otherwise)
                       └─ 16 kHz AudioContext → audio-worklet.js (mono frames)
                              → vad.js (energy gate, utterance segmentation)
                              → whisper-worker.js (Transformers.js, WebGPU/WASM)
                              → lib/detector.js:
                                   Stage 1  free heuristics (?, interrogatives,
                                            keywords, min length, speaker)
                                   Stage 2  LLM classify + coref-resolve + refine
                                            (lib/stage2.js → Astra; fallback: raw)
                                   dedup (Jaccard ≥ 0.8) + 20 s cool-down
                                   concurrency cap 3, no cancellation
                              → QuestionEvent ──▶ panel (question cards)
```

Key invariants (from the spec):

- **Interims never trigger retrieval** — only VAD-finalized utterances enter
  the detector; the panel's "Speaking…/Transcribing…" hint is cosmetic.
- **Never feed Whisper silence** — the VAD trims dead air (hallucination
  guard) and force-cuts monologues before the 30 s window.
- **In-flight Stage-2 calls are never cancelled** — each question becomes its
  own card, newest on top; pinned cards stay on top.
- **Manual "Ask this"** bypasses Stage 1, still gets Stage-2 refinement.

## File map

| File | Role |
|---|---|
| `background.js` | SW: streamId mint, offscreen lifecycle, message hub |
| `offscreen.js` | audio engine: capture, re-pipe to speakers, VAD, worker mgmt |
| `audio-worklet.js` | 16 kHz mono framer (100 ms batches) |
| `vad.js` | energy-gate utterance segmentation (Silero-swappable) |
| `whisper-worker.js` | Whisper via Transformers.js, WebGPU→WASM; whisper-small default, q4 decoder |
| `lib/lexicon.js` | fuzzy domain-term correction (brand names Whisper can't spell) |
| `lib/detector.js` | Part B: Stage 1 gate, context ring, dedup, concurrency |
| `lib/stage2.js` | Stage 2 LLM client (Astra transport, heuristic fallback) |
| `lib/messaging.js` | typed message constants + wrappers |
| `panel.html/js/css` | side-panel UI |
| `content.js` | Meet-tab glue (call detection only) |
| `lib/vendor/` | vendored Transformers.js + ONNX Runtime (MV3 CSP: no CDN code) |

## Demo checklist

- [ ] WebGPU machine (`chrome://gpu` → "WebGPU: Hardware accelerated")
- [ ] Model pre-warmed (start/stop once; progress bar completed)
- [ ] Astra API key saved in panel settings (or accept "unrefined" tags)
- [ ] Tab audio audible after Start (re-pipe working)
- [ ] Scripted question audio ready (synthetic — no real customer data)

## Known limits / next steps

- Speaker diarization is best-effort absent → consultant's own questions can
  fire cards (the spec allows this for MVP; the Stage-2 prompt filters some).
- Energy-gate VAD is tuned for clean demo audio; swap in Silero ONNX
  (`vad.js` keeps the same callback interface) for noisy calls.
- `whisper-small` upgrade: change `DEFAULT_MODEL` in `whisper-worker.js`.
- Retrieval layer: subscribe to `QUESTION_EVENT` messages (see the `answer`
  placeholder element in `panel.js`).

## Testing

Logic tests (VAD segmentation, Stage-1 gate, dedup/cool-down, manual path)
run in plain Node: `node test/test-logic.mjs` (all 16 pass). Or
exercise end-to-end by playing a YouTube video in a Meet-like tab and watching
the transcript log in the panel.
