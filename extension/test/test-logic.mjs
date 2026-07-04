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

// ---------------- Manual ask is never droppable ------------------------------
// A working Stage-2 LLM may classify typed text ("seclore data residency")
// as isQuestion=false — but "Ask this" is an explicit user command.
{
  const events = [];
  const rejectingStage2 = {
    classifyRefine: async () => ({ isQuestion: false, confidence: 0.9, refinedQuery: '', topicTags: [] }),
  };
  const det = new QuestionDetector({ emit: (e) => events.push(e), stage2: rejectingStage2 });

  det.manualAsk('seclore data residency options');
  await new Promise((r) => setTimeout(r, 50));
  assert(events.length === 1, 'manual ask emitted despite isQuestion=false from LLM');
  assert(events[0].refinedQuery === 'seclore data residency options', 'manual ask keeps typed text as query');

  // Auto candidates ARE still droppable by the LLM.
  det.onFinalUtterance({
    id: 'x1', text: 'Does it support single sign-on for external users?', isFinal: true,
    speechFinal: true, speaker: 'unknown', startMs: 1000, endMs: 3000, confidence: 0.9,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert(events.length === 1, 'auto candidate still dropped when LLM says not-a-question');
}

// ---------------- Stitching + indirect asks --------------------------------
// Continuous speech gets soft-split at brief pauses (sometimes mid-question),
// and customers phrase questions as imperatives with no interrogative shape.
{
  const events = [];
  const det = new QuestionDetector({ emit: (e) => events.push(e) });
  const seg = (id, text, startMs, endMs) => ({
    id, text, isFinal: true, speechFinal: true, speaker: 'unknown',
    startMs, endMs, confidence: 0.9,
  });
  const flush = () => new Promise((r) => setTimeout(r, 60));

  // A question chopped in half by a pause / VAD soft-cut. Neither half fires
  // alone (the first ends dangling, the second is a fragment); stitched they
  // form one question. Note the STT-added stray period on the dangling half.
  det.onFinalUtterance(seg('t1', 'And one more thing, what is the.', 10000, 13000));
  det.onFinalUtterance(seg('t2', 'efficacy of DSPM AI in policy server?', 13600, 16000));
  await flush();
  assert(events.length === 1, `stitch: chopped question reassembled (${events.length})`);
  assert(
    events[0]?.refinedQuery.includes('what is the efficacy of DSPM AI'),
    `stitch: full question text (got "${events[0]?.refinedQuery}")`
  );

  // No stitching across a long gap (> 6s): fragments stay dead.
  det.onFinalUtterance(seg('t3', 'So the next thing I want to check is the.', 30000, 33000));
  det.onFinalUtterance(seg('t4', 'backup retention period thing?', 41000, 43000)); // 8s later
  await flush();
  // t4 alone ends with '?' so it fires by itself, but WITHOUT the t3 prefix.
  const t4Event = events.find((e) => e.refinedQuery.includes('backup retention'));
  assert(t4Event && !t4Event.refinedQuery.includes('want to check'), 'stitch: not applied across long gaps');

  // Indirect asks with no interrogative shape must fire.
  const before = events.length;
  det.onFinalUtterance(seg('t5', 'Tell me about your pricing model.', 50000, 52000));
  det.onFinalUtterance(seg('t6', 'I wanted to understand how the licensing works.', 55000, 58000));
  det.onFinalUtterance(seg('t7', 'We would like to know whether data residency is supported.', 60000, 63000));
  det.onFinalUtterance(seg('t8', 'That all makes sense to me.', 65000, 67000)); // statement — no fire
  await flush();
  assert(events.length === before + 3, `indirect asks fire (${events.length - before}/3)`);
}

// ---------------- Non-Latin questions (Arabic ؟, CJK ？) ---------------------
{
  const events = [];
  const det = new QuestionDetector({ emit: (e) => events.push(e) });
  const seg = (id, text, endMs) => ({
    id, text, isFinal: true, speechFinal: true, speaker: 'unknown',
    startMs: endMs - 2000, endMs, confidence: 0.9,
  });

  det.onFinalUtterance(seg('a1', 'هل يدعم النظام تسجيل الدخول الموحد؟', 5000)); // Arabic + ؟
  det.onFinalUtterance(seg('a2', '这个系统支持单点登录吗？', 10000)); // Chinese, no spaces, fullwidth ？
  det.onFinalUtterance(seg('a3', 'شكرا جزيلا.', 15000)); // Arabic statement — no fire
  await new Promise((r) => setTimeout(r, 60));

  assert(events.length === 2, `unicode: Arabic + Chinese questions fire (${events.length})`);
  assert(events.some((e) => e.refinedQuery.includes('؟')), 'unicode: Arabic ؟ recognized as question mark');
}

// ---------------- Deepgram STT client --------------------------------------
{
  const { DeepgramClient, floatTo16BitPCM, keywordsFromTerms } = await import('../lib/deepgram.js');

  const pcm = floatTo16BitPCM(new Float32Array([0, 1, -1, 0.5, 2, -2]));
  assert(pcm[1] === 32767 && pcm[2] === -32768, 'deepgram: float->int16 full scale');
  assert(pcm[4] === 32767 && pcm[5] === -32768, 'deepgram: out-of-range samples clamped');

  const kws = keywordsFromTerms(['Seclore Online', 'policy server', 'DRM', 'Seclore']);
  assert(kws.includes('Seclore') && kws.includes('policy') && kws.includes('server'), 'deepgram: keywords from terms');
  assert(!kws.includes('DRM'), 'deepgram: short words excluded from boosts');
  assert(new Set(kws).size === kws.length, 'deepgram: keywords deduped');

  // transcribe() parses the real response shape (captured from a live call).
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: 'What is Seclore Online?', confidence: 0.98 }] }] },
      }),
    };
  };

  // Default: AUTO — per-utterance detect_language on nova-3, keyterm boosts
  // on (verified live). Handles Hindi/English/Arabic speakers on one call.
  const dg = new DeepgramClient(() => ({}));
  const out = await dg.transcribe(new Float32Array(1600), ['Seclore']);
  assert(out.text === 'What is Seclore Online?' && out.confidence === 0.98, 'deepgram: transcript parsed');
  assert(capturedUrl.includes('model=nova-3') && capturedUrl.includes('detect_language=true'), 'deepgram: default auto-detects language');
  assert(!/[?&]language=/.test(capturedUrl), 'deepgram: no pinned language in auto mode');
  assert(capturedUrl.includes('keyterm=Seclore'), 'deepgram: keyterm boost sent');
  assert(capturedUrl.includes('sample_rate=16000') && capturedUrl.includes('encoding=linear16'), 'deepgram: PCM params set');

  // Pinned languages disable detection.
  await new DeepgramClient(() => ({ sttLanguage: 'hi' })).transcribe(new Float32Array(1600), ['Seclore']);
  assert(capturedUrl.includes('language=hi') && !capturedUrl.includes('detect_language'), 'deepgram: hindi pin supported');
  await new DeepgramClient(() => ({ sttLanguage: 'ar' })).transcribe(new Float32Array(1600), ['Seclore']);
  assert(capturedUrl.includes('language=ar') && capturedUrl.includes('keyterm=Seclore'), 'deepgram: arabic pin supported');

  // Unsupported/stale configured values (e.g. old 'multi') fall back to auto.
  await new DeepgramClient(() => ({ sttLanguage: 'multi' })).transcribe(new Float32Array(1600), []);
  assert(capturedUrl.includes('detect_language=true'), 'deepgram: stale language value falls back to auto');

  // detected_language from the response surfaces on the result.
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: {
          channels: [{
            detected_language: 'hi',
            alternatives: [{ transcript: 'यह क्या है?', confidence: 0.91 }],
          }],
        },
      }),
    };
  };
  const outHi = await new DeepgramClient(() => ({})).transcribe(new Float32Array(1600), []);
  assert(outHi.language === 'hi' && outHi.text === 'यह क्या है?', 'deepgram: detected language surfaced');

  // API errors surface with status + body.
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
  let threw = false;
  try {
    await new DeepgramClient(() => ({})).transcribe(new Float32Array(1600), []);
  } catch (err) {
    threw = /Deepgram 400/.test(String(err.message));
  }
  assert(threw, 'deepgram: errors surface with status');
}

// ---------------- Markdown tables in answers --------------------------------
{
  const { parseAnswer } = await import('../lib/markdown.js');
  const raw = `### Encryption Comparison

| Algorithm | Usage | Strength |
|---|---|---|
| **AES 256** | File encryption [[1]](https://seclore.com/doc.pdf) | Default |
| RSA 2048 | Key exchange | Standard |
| RSA 4096 | TLS | Enhanced |

That covers the main options.`;

  const { blocks, sources } = parseAnswer(raw);
  const table = blocks.find((b) => b.type === 'table');
  assert(!!table, 'table: parsed as table block');
  assert(table.header?.length === 3, `table: 3 header cells (${table.header?.length})`);
  assert(table.rows.length === 3, `table: 3 data rows (${table.rows.length})`);
  assert(
    table.rows[0].some((cell) => cell.some((i) => i.type === 'bold' && i.text === 'AES 256')),
    'table: bold inside cell preserved'
  );
  assert(
    table.rows[0].some((cell) => cell.some((i) => i.type === 'cite')),
    'table: citation inside cell becomes chip'
  );
  assert(sources.length === 1, 'table: cell citation registered as source');
  assert(
    blocks.some((b) => b.type === 'para' && b.inlines.some((i) => String(i.text).includes('covers the main options'))),
    'table: prose after table still parsed'
  );

  // Header-less table (no separator row) still renders as rows.
  const { blocks: b2 } = parseAnswer('| a | b |\n| c | d |');
  const t2 = b2.find((b) => b.type === 'table');
  assert(t2 && t2.header === null && t2.rows.length === 2, 'table: header-less table handled');
}

// ---------------- Post-call summary prompt ----------------------------------
{
  const { buildSummaryPrompt } = await import('../lib/summary.js');

  const transcript = [
    { t: 5000, text: 'Thanks for joining, today we will cover Seclore Online.' },
    { t: 21000, text: 'What encryption does Seclore support?' },
    { t: 60000, text: 'Okay that makes sense, and what about IP restrictions?' },
  ];
  const questions = [
    { q: 'What encryption does Seclore support?', answered: true },
    { q: 'Is IP restriction based on private or public IP?', answered: false },
  ];

  const prompt = buildSummaryPrompt(transcript, questions);
  assert(prompt.includes('## Meeting Summary') && prompt.includes('## Follow-up Email Draft'), 'summary: prompt has required sections');
  assert(prompt.includes('[answered on call] What encryption'), 'summary: answered question marked');
  assert(prompt.includes('[NEEDS FOLLOW-UP] Is IP restriction'), 'summary: open question marked');
  assert(prompt.includes('[5s] Thanks for joining'), 'summary: transcript timestamped');

  // Long transcripts keep the tail and note the truncation.
  const long = Array.from({ length: 800 }, (_, i) => ({
    t: i * 5000,
    text: `Utterance number ${i} with some padding words to add length here.`,
  }));
  const p2 = buildSummaryPrompt(long, [], 5000);
  assert(p2.includes('(earlier part truncated)'), 'summary: truncation noted');
  assert(p2.includes('Utterance number 799'), 'summary: tail of transcript kept');
  assert(!p2.includes('Utterance number 1 '), 'summary: head of transcript dropped');
  assert(p2.length < 7000, `summary: prompt bounded (${p2.length} chars)`);

  // Empty question list handled.
  assert(buildSummaryPrompt(transcript, []).includes('(none detected)'), 'summary: no-questions case');
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
