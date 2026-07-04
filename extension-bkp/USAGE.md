# How to Use the Pre-Sales Co-Pilot

A step-by-step guide for consultants. The extension listens to your Google
Meet call, transcribes it **locally on your machine** (no audio is sent
anywhere), detects when the customer asks a technical question, and shows
each question as a card in a side panel.

---

## 1. One-time setup

### Install the extension

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the extension: click the puzzle-piece icon in the toolbar → pin
   **Pre-Sales Co-Pilot**.

### Check your machine can run it

- You need **Chrome 113 or newer**.
- Go to `chrome://gpu` and confirm **WebGPU: Hardware accelerated**.
  Without WebGPU the extension still works but transcription may lag behind
  the conversation.

### Download the speech model (pre-warm)

The first capture downloads the Whisper speech-recognition model (~250 MB
for the default `whisper-small`) and caches it. Do this **before** your
first real call:

1. Open any Google Meet tab (even an empty meeting works).
2. With that tab focused, click the extension icon → the side panel opens
   and capture starts.
3. Wait for the model progress bar to reach 100%.
4. Press **Stop** in the panel.

From now on the model loads from cache in a few seconds, even offline.

### Tune transcription accuracy

Two settings in the panel (expand **Settings**) control STT quality:

- **STT model** — `whisper-small` (default) is markedly better on technical
  vocabulary; `whisper-base` is faster on weak machines. A model change
  takes effect on the next capture start and downloads once.
- **Domain terms** — product and brand names that no speech model can spell
  ("Seclore" comes out as "secular", "cyclore", "the clue"…). List them
  comma-separated (e.g. `Seclore, Seclore Online, policy server`) and the
  extension fuzzy-corrects mishearings to the exact term before display and
  detection. Common Seclore terms are built in; add your own product names,
  feature names, and acronyms here.

### Connect the Stage-2 LLM (recommended)

With an LLM connected, detected questions are cleaned up and made
self-contained (e.g. *"does it support that?"* becomes *"Does the platform
support SAML-based SSO for external users?"*).

1. In the side panel, expand **Settings**.
2. Paste your **Astra API key** (get one from the Astra team; don't reuse
   keys committed in code or shared in chat).
3. Leave the URL and persona fields empty unless told otherwise (defaults:
   `https://astra.seclore.com`, refiner persona `3`, answer persona `2`).
4. Click **Save**.

The same key powers two things: **question refinement** (Stage-2 cleanup of
the detected question) and **answers** (the knowledge lookup shown in each
card).

Your key is stored only in this browser's local extension storage.

> **No key?** Everything still works — detected questions just appear
> verbatim with an **unrefined** tag instead of being rewritten.

---

## 2. Using it on a call

1. **Join your Google Meet call** as usual.
2. **With the Meet tab focused, click the extension icon in the toolbar.**
   One click does everything: it opens the side panel (docked to the right —
   invisible to other participants) **and starts capture**. Chrome only
   allows tab capture from that toolbar click, which is why there is no
   separate "arm" step. The status dot turns green ("Capturing") once the
   model is ready, and you will still hear the call normally.

   > The panel's **Start** button only works for restarting after a Stop on
   > the same page. After reloading the Meet tab, or if Start complains,
   > just click the toolbar icon again.
3. **Just talk.** Watch the panel:

   | Panel element | What it means |
   |---|---|
   | Status dot (green, pulsing) | Audio is being captured and transcribed |
   | `WEBGPU` / `WASM` badge | Which engine Whisper is running on |
   | `stt 0.8s` badge | How long the last transcription took |
   | *Speaking…* (green) | Someone is talking; an utterance is in progress |
   | *Transcribing…* (amber) | Utterance ended; Whisper is working on it |
   | *Listening* | Idle between utterances |

4. **When the customer asks a technical question**, a card appears at the
   top of the feed within a couple of seconds:
   - **Bold text** — the refined, self-contained question.
   - **`heard: "…"`** — what was actually said, for sanity-checking.
   - **Colored dot** — detection confidence (green = high, amber = medium,
     red = low).
   - **Tags** — detected topics (SSO, encryption, …). `manual` means you
     triggered it yourself; `unrefined` means no LLM was available.
5. **Press Stop** when the call ends. Tab audio and transcription stop
   immediately.

### Card controls

- **📌 Pin** — keeps a card at the top of the feed (e.g. a question you
  promised to follow up on). Click again to unpin.
- **✕ Dismiss** — removes a card.
- New questions never overwrite old ones — every question gets its own card.

### Manual "Ask this"

If the detector misses a question, or you want to look something up
yourself:

1. Type the question into the text box above the feed — or leave it empty
   to use the **last thing that was said** (shown as the placeholder text).
2. Click **Ask this** (or press Enter).

Manual questions skip detection entirely, so they always produce a card.

### Transcript log

Expand **Transcript** at the bottom of the panel to see the last 12
finalized utterances with timestamps — useful for checking what the system
actually heard.

---

## 3. Things to know

- **You keep hearing the call.** Capturing normally mutes a tab; the
  extension re-pipes the audio to your speakers automatically. If audio ever
  drops out, press Stop and Start again.
- **Duplicates are suppressed.** If the customer rephrases the same question
  within ~20 seconds, you won't get a second card. After the cool-down, a
  genuine re-ask fires again.
- **Your own questions may fire cards.** Speaker separation isn't in the
  MVP, so if *you* ask "does that support SSO?", a card may appear. Just
  dismiss it.
- **Privacy:** call audio never leaves your machine. Only when a question
  candidate is detected is its **text** (plus a few seconds of surrounding
  transcript) sent to the Astra LLM for refinement — and nothing at all is
  sent if no API key is configured.
- **English only** for now; Google Meet in Chrome only.
- **Testing alone doesn't work the way you'd expect.** The extension hears
  the **tab's audio** — i.e. what the *other participants* say. Google Meet
  never plays your own microphone back through the tab, so sitting alone in
  a meeting and talking produces nothing (or noise-hallucinations). To test
  solo, join the same meeting as a second participant from your phone or an
  incognito window and speak *there*, or play a scripted recording into the
  call.

---

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| "Open a Google Meet call tab, then click the toolbar icon" | You clicked the icon on a non-Meet tab — switch to the Meet call tab and click the icon there |
| "Extension has not been invoked…" / Start button complains | Don't use the panel's Start button for the first start — capture can only begin from the **toolbar icon click**. Focus the Meet tab and click the icon; repeat after every reload of the Meet tab |
| Start fails / other permission error | Reload the Meet tab, then click the toolbar icon again; check the extension has not been disabled in `chrome://extensions` |
| Stuck on "Loading model…" | First run needs internet for the model download (~250 MB for small); check your connection, then Stop/Start |
| Transcription lags far behind | You're on WASM fallback — check `chrome://gpu` for WebGPU; close GPU-heavy tabs/apps. Or switch **STT model** to `whisper-base` in Settings |
| Product/brand names come out wrong | Add them to **Domain terms** in Settings — mishearings are fuzzy-corrected to the exact spelling you give |
| Can't hear the call after Start | Press Stop, then Start again (re-pipe restarts) |
| Transcript shows gibberish, `[inaudible]`, "(music)", repeated words | Whisper is hearing noise, music, or near-silence — not clear speech. Most common cause: **testing alone** (your own mic is never in the tab audio — see "Things to know"). Have the remote side speak clearly, one person at a time |
| No cards appearing | Check the Transcript log — if clean utterances show up there, questions are being filtered: phrase them as questions ("Does it support…?"); use **Ask this** as the fallback. If the transcript itself is garbled, fix the audio first (row above) |
| Cards say "unrefined" | No Stage-2 key configured or Astra unreachable — add/verify the API key in Settings |
| Wrong/garbled transcript | Whisper struggles with crosstalk and heavy accents on `whisper-base`; the demo machine should use a good mic/speaker setup on the *remote* side |

---

## 5. What happens after a question is detected?

Each card immediately shows *"⏳ Fetching answer…"* and the question is sent
to the Astra **Answer Persona** (a knowledge-base persona; default `2`). The
answer replaces the placeholder when it arrives — typically a few seconds.
Several questions in a row are answered in parallel (capped at 3); nothing
is cancelled or overwritten.

If a card shows *"⚠ No Astra API key configured"*, add your key in Settings
— answers (unlike detection) always need the Astra API.
