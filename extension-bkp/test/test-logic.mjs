// Logic tests for VAD segmentation, detector Stage 1 + dedup, and the
// domain-term lexicon corrector (node, no chrome).
import { VAD } from '../vad.js';
import { createCorrector, DEFAULT_TERMS } from '../lib/lexicon.js';

// --- simulate the OFFSCREEN environment: chrome exists but has NO storage
// (offscreen docs only get chrome.runtime). This is the environment that
// silently killed all question cards before the config-push fix. ---
globalThis.chrome = { runtime: {} };

const { QuestionDetector } = await import(
  '../lib/detector.js'
);

let failures = 0;
function assert(cond, name) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
}

// ---------------- VAD ----------------
{
  const segments = [];
  let speechStarts = 0;
  const vad = new VAD({
    onSpeechStart: () => speechStarts++,
    onSegment: (audio, startMs, endMs) => segments.push({ len: audio.length, startMs, endMs }),
  });

  const SR = 16000;
  function tone(ms, amp) {
    const n = Math.floor((SR * ms) / 1000);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
    return out;
  }

  // 1s silence, 2s speech, 1s silence, 0.1s blip, 1.5s silence, 3s speech, 2s silence
  const parts = [
    tone(1000, 0.001),
    tone(2000, 0.2),
    tone(1000, 0.001),
    tone(100, 0.2),   // blip < minSpeechMs — should be dropped
    tone(1500, 0.001),
    tone(3000, 0.25),
    tone(2000, 0.001),
  ];
  // feed in 100ms chunks like the worklet does
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 1600) vad.push(p.slice(i, i + 1600));
  }
  vad.flush();

  assert(segments.length === 2, `VAD: 2 segments detected (got ${segments.length})`);
  assert(speechStarts >= 2, `VAD: speech-start fired (${speechStarts})`);
  if (segments.length === 2) {
    const s0 = segments[0];
    assert(Math.abs(s0.startMs - 1000) < 400, `VAD: seg0 starts ~1000ms (got ${s0.startMs})`);
    const durMs = (s0.len / SR) * 1000;
    assert(durMs > 1800 && durMs < 3500, `VAD: seg0 duration sane (${durMs.toFixed(0)}ms)`);
  }

  // Long monologue: 35s of speech must be force-cut into >1 segment
  const segs2 = [];
  const vad2 = new VAD({ onSegment: (a) => segs2.push(a.length) });
  const long = tone(35000, 0.2);
  for (let i = 0; i < long.length; i += 1600) vad2.push(long.slice(i, i + 1600));
  vad2.flush();
  assert(segs2.length >= 2, `VAD: 35s monologue force-cut (${segs2.length} segments)`);
  assert(Math.max(...segs2) <= 29 * SR, 'VAD: no segment exceeds ~29s');

  // Continuous talker: ~27s of speech with only brief (~350ms) pauses between
  // sentences — far short of the 700ms close gap. Soft split must cut at
  // those pauses once a segment is ≥8s, so questions surface in seconds.
  const segs3 = [];
  const vad3 = new VAD({ onSegment: (a) => segs3.push(a.length) });
  for (let s = 0; s < 5; s++) {
    const speech = tone(5000, 0.2);
    for (let i = 0; i < speech.length; i += 1600) vad3.push(speech.slice(i, i + 1600));
    const pause = tone(350, 0.001);
    for (let i = 0; i < pause.length; i += 1600) vad3.push(pause.slice(i, i + 1600));
  }
  vad3.flush();
  assert(
    segs3.length >= 2,
    `VAD: continuous talk soft-split into segments (${segs3.length})`
  );
  assert(
    Math.max(...segs3) <= 13 * SR,
    `VAD: soft-split segments stay short (max ${(Math.max(...segs3) / SR).toFixed(1)}s)`
  );
}

// ---------------- Detector Stage 1 + dedup (fallback Stage 2, no key) -------
{
  const events = [];
  const det = new QuestionDetector({ emit: (e) => events.push(e) });

  const seg = (id, text, endMs) => ({
    id, text, isFinal: true, speechFinal: true, speaker: 'unknown',
    startMs: endMs - 2000, endMs, confidence: 0.9,
  });

  const flush = () => new Promise((r) => setTimeout(r, 50));

  // Statements / backchannel: should NOT fire
  det.onFinalUtterance(seg('s1', 'And the platform handles identity centrally.', 5000));
  det.onFinalUtterance(seg('s2', 'Okay, sounds good.', 8000));
  det.onFinalUtterance(seg('s3', 'What?', 9000)); // too short
  await flush();
  assert(events.length === 0, `Stage 1 drops statements/short (${events.length} events)`);

  // Real question with '?': fires
  det.onFinalUtterance(seg('s4', 'Does it support single sign-on for external users?', 12000));
  await flush();
  assert(events.length === 1, 'Stage 1 passes real question');
  assert(events[0].refinedQuery.includes('single sign-on'), 'fallback uses raw text as query');
  assert(events[0].stage2Fallback === true, 'fallback flag set without API key');

  // Interrogative without '?' (Whisper sometimes drops punctuation): fires
  det.onFinalUtterance(seg('s5', 'how do you handle encryption key rotation on premise', 20000));
  await flush();
  assert(events.length === 2, 'interrogative-start without ? passes');

  // Near-duplicate within cool-down: suppressed
  det.onFinalUtterance(seg('s6', 'Does it support single sign-on for the external users?', 25000));
  await flush();
  assert(events.length === 2, `dedup suppresses near-duplicate (${events.length})`);

  // Manual ask: bypasses Stage 1 even for a statement
  det.manualAsk('data residency options for EU customers');
  await flush();
  assert(events.length === 3, 'manual ask bypasses Stage 1');
  assert(events[2].trigger === 'manual', 'manual trigger flagged');

  // Consultant speaker: dropped
  det.onFinalUtterance({ ...seg('s7', 'Can you see my screen now?', 30000), speaker: 'consultant' });
  await flush();
  assert(events.length === 3, 'consultant utterances dropped');

  // Context window: keeps at most 6 turns
  for (let i = 0; i < 10; i++) det.onFinalUtterance(seg(`c${i}`, `Filler statement number ${i} here.`, 40000 + i * 1000));
  assert(det.context.length <= 6, `context capped at 6 (${det.context.length})`);
}

// ---------------- Regression: real-call utterances in the offscreen env ----
// These exact utterances produced ZERO cards in a live call: chrome.storage
// doesn't exist in offscreen documents, so the Stage-2 config lookup threw
// before the no-key fallback could run, and the error was swallowed.
{
  const events = [];
  const det = new QuestionDetector({ emit: (e) => events.push(e) });
  const seg = (id, text, endMs) => ({
    id, text, isFinal: true, speechFinal: true, speaker: 'unknown',
    startMs: endMs - 2000, endMs, confidence: 0.9,
  });

  det.onFinalUtterance(seg('r1', 'What is policy server?', 146000));
  det.onFinalUtterance(seg('r2', 'What is policy?', 152000)); // 3 words — must pass now
  det.onFinalUtterance(seg('r3', 'Sorry.', 154000));
  det.onFinalUtterance(seg('r4', 'Thank you.', 156000));
  await new Promise((r) => setTimeout(r, 50));

  assert(events.length === 2, `live-call regression: 2 cards from 4 utterances (${events.length})`);
  assert(
    events.some((e) => e.refinedQuery === 'What is policy server?'),
    'live-call regression: exact question surfaces as the card query'
  );
}

// ---------------- Regression: lead-in questions + multi-question utterances -
// Real transcript from a live call where 7 questions were asked and only 2
// were detected: questions arrive after lead-ins ("another one would be…"),
// without trailing "?", and sometimes two per utterance.
{
  const events = [];
  const det = new QuestionDetector({ emit: (e) => events.push(e) });
  const seg = (id, text, endMs) => ({
    id, text, isFinal: true, speechFinal: true, speaker: 'unknown',
    startMs: endMs - 3000, endMs, confidence: 0.9,
  });

  const utterances = [
    "Yeah, so I'm just letting you know some of my queries. So the first query would be what encryption does secular supports second one? Would we is IP based restriction Based on private ip or public ips",
    "And if Sekhla can't block screenshots on browser, then what is the prevention mechanism?",
    'Another one would be how can I ensure that users cannot protect the file with agents.',
    'The next one would be what is the', // truncated fragment — must NOT fire
    'because you have DSP MAI then why files are not opening in browser when I opt for a lock file on device.',
    'And next one would be if I add user twice in policy with different rights, what writes the policies will take and.',
    "Yep, that's it from my list.", // wrap-up — must NOT fire
  ];
  utterances.forEach((u, i) => det.onFinalUtterance(seg(`m${i}`, u, 730000 + i * 10000)));
  await new Promise((r) => setTimeout(r, 80));

  assert(
    events.length === 6,
    `lead-in regression: 6 questions from 7 utterances (got ${events.length}: ${events.map((e) => `"${e.refinedQuery}"`).join(', ')})`
  );
  const queries = events.map((e) => e.refinedQuery);
  assert(queries.some((q) => q.includes('what encryption does')), 'lead-in: encryption question found');
  assert(queries.some((q) => q.startsWith('Would we is IP based restriction')), 'lead-in: IP restriction question split out separately');
  assert(queries.some((q) => q.includes('why files are not opening')), 'lead-in: mid-sentence why-question found');
  assert(queries.some((q) => q.includes('add user twice in policy')), 'lead-in: policy-rights question found');
  assert(!queries.some((q) => q === 'The next one would be what is the'), 'lead-in: truncated fragment rejected');
  assert(!queries.some((q) => q.includes('from my list')), 'lead-in: wrap-up rejected');
}

// ---------------- Lexicon: real Whisper mishearings from a live call -------
{
  const correct = createCorrector(DEFAULT_TERMS);
  const cases = [
    ['What is secular online?', 'What is Seclore Online?'],
    ['What is Cyclore Online?', 'What is Seclore Online?'],
    ['What is the Claw Online?', 'What is the Seclore Online?'],
    ['What is the clue online?', 'What is the Seclore Online?'],
    ['What a sequel online!', 'What a Seclore Online!'],
    ['What is the core online?', 'What is the Seclore Online?'],
    ['Can you let me know what is police, sir?', 'Can you let me know what is policy server?'],
    // canonical forms and unrelated sentences must pass through unchanged
    ['What is policy server?', 'What is policy server?'],
    ['What is desktop client?', 'What is desktop client?'],
    ['What do you think makes a place feel like home?', 'What do you think makes a place feel like home?'],
    ['Are you speaking enough?', 'Are you speaking enough?'],
    ['What is the problem?', 'What is the problem?'],
  ];
  for (const [input, expected] of cases) {
    const out = correct(input);
    assert(out === expected, `lexicon: "${input}" -> "${out}"`);
  }

  // user-supplied extra terms
  const custom = createCorrector([...DEFAULT_TERMS, 'Email Auto Protector']);
  assert(
    custom('What is email auto protector?') === 'What is Email Auto Protector?',
    'lexicon: custom terms normalize casing'
  );
}

// ---------------- AnswerClient: Astra retrieval (test.py flow) --------------
{
  const { AnswerClient } = await import('../lib/answers.js');

  // No key configured -> clean error result, never throws.
  const noKey = new AnswerClient(() => ({}));
  const r1 = await new Promise((res) => noKey.getAnswer('q', res));
  assert(r1.ok === false && /API key/.test(r1.error), 'answers: no key -> error result');

  // Happy path against a stubbed Astra: session created once, answer parsed
  // from answer_citationless (same fields test.py reads).
  let sessionCalls = 0;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('create-chat-session')
        ? (sessionCalls++, { chat_session_id: 'sess_1' })
        : { answer_citationless: 'Seclore Online is the SaaS edition of Seclore.' },
  });
  const client = new AnswerClient(() => ({ astraApiKey: 'k' }));
  const r2 = await new Promise((res) => client.getAnswer('What is Seclore Online?', res));
  const r3 = await new Promise((res) => client.getAnswer('What is policy server?', res));
  assert(r2.ok && r2.answer.startsWith('Seclore Online'), 'answers: parses answer_citationless');
  assert(r3.ok && sessionCalls === 1, 'answers: chat session created once and reused');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
