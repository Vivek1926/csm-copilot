// Part B — live question detection.
//
// Stage 0: only finalized utterances arrive here (VAD boundary + Whisper text).
// Stage 1: free local heuristic gate — kills most of the transcript at 0 cost.
// Stage 2: cheap LLM classify + coreference-resolve + refine (see stage2.js).
// Then dedup + cool-down, capped-concurrency, and QuestionEvent emission.

import { Stage2Client } from './stage2.js';

const INTERROGATIVE_START =
  /^(how|what|why|when|where|which|who|whose|can|could|does|do|did|is|are|was|were|will|would|should|shall|may|might)\b/i;

const EMBEDDED_CUES =
  /\b(how (do|does|can|would|long|many|much)|what (about|happens|if)|is it possible|is there (a|any)|are there (any)?|do you (support|have|offer|provide|handle)|does (it|that|this|the)|can (we|you|it|they)|any way to|wondering (if|whether|how)|curious (if|whether|about)|tell me (about|how)|walk me through)\b/i;

// A wh-question buried mid-sentence after a lead-in ("the next one would be
// WHY files ARE not opening…", "…WHAT rights the policy WILL take"). Requires
// a wh-word, an auxiliary verb within 50 chars, and at least two more words
// after the auxiliary — the tail guard rejects truncated fragments like
// "the next one would be what is the".
const WH_CLAUSE =
  /\b(what|why|how|which|whose|whom|when|where|who)\b[^.?!]{0,50}?\b(is|are|was|were|am|do|does|did|can|could|will|would|shall|should|may|might|happens)\b\s+\S+\s+\S+/i;

// Indirect asks — customers phrase questions as imperatives or statements
// ("tell me about X", "I wanted to understand Y") with no interrogative shape.
const INDIRECT_ASK =
  /\b(tell (me|us) (about|more|how|what|why)|explain|describe|walk (me|us) through|help (me|us) understand|clarify|elaborate on|(want|wanted|would like|need|needed) to (know|understand|check|confirm|ask)|curious (about|to know)|interested (in|to) know(ing)?|let (me|us) know (what|how|if|whether|about)|give (me|us) (an|some|the|a) (idea|overview|details|sense))\b/i;

// A sentence ending on one of these (optionally with a stray period Deepgram
// added) is mid-thought — a question probably continues in the next segment.
const DANGLING_END =
  /\b(the|a|an|of|for|in|on|to|with|and|or|is|are|was|were|what|which|how|why|when|where|whether|if|does|do|can|will|would|about|your|our|their|its)\.?\s*$/i;

const DEFAULT_KEYWORDS = [
  'sso', 'saml', 'oauth', 'oidc', 'scim', 'ldap', 'active directory',
  'api', 'rate limit', 'webhook', 'sdk', 'integration',
  'retention', 'encryption', 'encrypt', 'key management', 'kms', 'hsm',
  'export', 'import', 'migration', 'backup',
  'rbac', 'permission', 'role', 'audit', 'log', 'compliance', 'gdpr', 'soc 2',
  'dlp', 'drm', 'classification', 'watermark', 'policy', 'revoke', 'revocation',
  'on-prem', 'on premise', 'cloud', 'saas', 'deployment', 'tenant',
  'license', 'pricing', 'sla', 'uptime', 'scalability', 'latency',
];

const MIN_WORDS = 3; // filters "what?", "sorry?" but keeps "What is X?"

function tokenize(text) {
  // Unicode-aware: Arabic/CJK/Cyrillic letters are words too, not stripped.
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

// Min-length that works across scripts: word count for spaced languages,
// character count as fallback for unspaced ones (Chinese, Japanese, Thai).
function longEnough(text) {
  const tokens = tokenize(text);
  return tokens.length >= MIN_WORDS || tokens.join('').length >= 8;
}

// Customers pack several questions into one breath ("…what encryption does
// it support? And is IP restriction private or public?"). Gate each sentence
// independently so every question gets its own candidate/card and preamble
// sentences ("just letting you know my queries") don't drag them down.
// Terminators include the Arabic question mark (؟), CJK fullwidth ？/！ and
// the CJK period (。) so non-English transcripts split correctly.
function splitSentences(text) {
  const parts = text.match(/[^.?!。？！؟]+[.?!。？！؟]*/g) || [text];
  return parts.map((s) => s.trim()).filter(Boolean);
}

// Question-mark and sentence-terminator checks shared by the gate + stitcher.
const ENDS_QUESTION = /[?？؟]\s*$/;
const ENDS_TERMINAL = /[.?!。？！؟]\s*$/;

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export class QuestionDetector {
  /**
   * @param {object} opts
   * @param {(event: object) => void} opts.emit        QuestionEvent sink
   * @param {(info: object) => void} [opts.onInfo]     status/debug sink
   */
  constructor({
    emit,
    onInfo,
    contextTurns = 6,
    contextMaxMs = 45000,
    cooldownMs = 20000,
    dedupThreshold = 0.8,
    maxConcurrent = 3,
    keywords = DEFAULT_KEYWORDS,
    stage2 = null,
  } = {}) {
    this.emit = emit || (() => {});
    this.onInfo = onInfo || (() => {});
    this.contextTurns = contextTurns;
    this.contextMaxMs = contextMaxMs;
    this.cooldownMs = cooldownMs;
    this.dedupThreshold = dedupThreshold;
    this.maxConcurrent = maxConcurrent;
    this.keywords = keywords;

    this.context = [];        // ring buffer of last N finalized turns
    this.recentEmitted = [];  // [{ tokens, at }] for dedup + cool-down
    // Cross-segment stitching: soft splits and mid-question pauses chop a
    // question across two utterances; the dangling tail is carried forward.
    this.pendingTail = null;  // { text, endMs }
    this.stitchGapMs = 6000;
    this.inFlight = 0;
    this.stage2Queue = [];    // candidates waiting for a concurrency slot
    this.candCounter = 0;
    this.qCounter = 0;
    this.stage2 = stage2 || new Stage2Client();
  }

  // -- Stage 0 entry point: a finalized utterance ---------------------------

  onFinalUtterance(segment) {
    this._addTurn(segment);

    // Stitch: if the previous utterance ended mid-thought and this one
    // follows quickly, join them so a question split by a pause or a VAD
    // soft-cut is evaluated whole.
    let text = segment.text;
    if (
      this.pendingTail &&
      (segment.startMs ?? 0) - this.pendingTail.endMs <= this.stitchGapMs
    ) {
      text = `${this.pendingTail.text.replace(/\.\s*$/, '')} ${text}`;
    }
    this.pendingTail = null;

    // Gate each sentence of the utterance independently — one utterance can
    // carry several questions, and each becomes its own candidate.
    let lastSentence = null;
    let lastPassed = false;
    for (const sentence of splitSentences(text)) {
      const verdict = this._stage1(sentence, segment.speaker);
      this.onInfo({ lastStage1: { text: sentence, ...verdict } });
      lastSentence = sentence;
      lastPassed = verdict.pass;
      if (!verdict.pass) continue;

      const candidate = {
        candidateId: `cand_${String(++this.candCounter).padStart(4, '0')}`,
        sourceSegmentId: segment.id,
        rawText: sentence,
        context: this.context.slice(0, -1).map((t) => ({ speaker: t.speaker, text: t.text })),
        heuristicReasons: verdict.reasons,
        trigger: 'auto',
      };
      this._enqueueStage2(candidate);
    }

    // Carry an unfinished, non-fired trailing sentence for stitching:
    // either unterminated, or "terminated" by STT but ending on a dangling
    // function word ("…what is the.").
    if (
      lastSentence &&
      !lastPassed &&
      (!ENDS_TERMINAL.test(lastSentence) || DANGLING_END.test(lastSentence))
    ) {
      this.pendingTail = { text: lastSentence, endMs: segment.endMs ?? 0 };
    }
  }

  /** Manual "Ask this" — bypasses Stage 1, still refined by Stage 2. */
  manualAsk(text) {
    if (!text || !text.trim()) return;
    const candidate = {
      candidateId: `cand_${String(++this.candCounter).padStart(4, '0')}`,
      sourceSegmentId: null,
      rawText: text.trim(),
      context: this.context.map((t) => ({ speaker: t.speaker, text: t.text })),
      heuristicReasons: ['manual_trigger'],
      trigger: 'manual',
    };
    this._enqueueStage2(candidate);
  }

  // -- Stage 1: local heuristic gate (free, ~0 ms) ---------------------------

  _stage1(text, speaker) {
    text = text.trim();
    const reasons = [];

    // Speaker filter (best effort — 'unknown' passes; only a positively
    // identified consultant is dropped).
    if (speaker === 'consultant') return { pass: false, reasons: ['speaker:consultant'] };

    if (!longEnough(text)) return { pass: false, reasons: ['too_short'] };

    if (ENDS_QUESTION.test(text)) reasons.push('ends_with_question_mark');

    const startMatch = text.match(INTERROGATIVE_START);
    if (startMatch) reasons.push(`interrogative:${startMatch[1].toLowerCase()}`);

    const embedMatch = text.match(EMBEDDED_CUES);
    if (embedMatch) reasons.push(`cue:${embedMatch[0].toLowerCase()}`);

    const whMatch = text.match(WH_CLAUSE);
    if (whMatch) reasons.push(`wh_clause:${whMatch[1].toLowerCase()}…${whMatch[2].toLowerCase()}`);

    const askMatch = text.match(INDIRECT_ASK);
    if (askMatch) reasons.push(`ask:${askMatch[0].toLowerCase().slice(0, 30)}`);

    const lower = text.toLowerCase();
    for (const kw of this.keywords) {
      if (lower.includes(kw)) {
        reasons.push(`keyword:${kw}`);
        break;
      }
    }

    // Pass if it *looks* interrogative (punctuation, leading interrogative,
    // an embedded cue, or a mid-sentence wh-clause). Keywords alone don't
    // fire — statements about SSO aren't questions — but they strengthen
    // real candidates.
    const interrogative = reasons.some(
      (r) =>
        r === 'ends_with_question_mark' ||
        r.startsWith('interrogative:') ||
        r.startsWith('cue:') ||
        r.startsWith('wh_clause:') ||
        r.startsWith('ask:')
    );
    return { pass: interrogative, reasons };
  }

  // -- Stage 2: LLM classify + refine (capped concurrency, no cancellation) --

  _enqueueStage2(candidate) {
    this.stage2Queue.push(candidate);
    this._drainQueue();
  }

  _drainQueue() {
    while (this.inFlight < this.maxConcurrent && this.stage2Queue.length > 0) {
      const candidate = this.stage2Queue.shift();
      this.inFlight++;
      // NEVER cancel in-flight work — each question is its own card.
      // classifyRefine is contractually non-throwing (it degrades to a
      // heuristic fallback); if something still escapes, surface it and
      // emit the raw question rather than dropping it silently.
      this.stage2
        .classifyRefine(candidate)
        .then((result) => this._onStage2Result(candidate, result))
        .catch((err) => {
          this.onInfo({ stage2Error: String(err?.message || err) });
          this._onStage2Result(candidate, {
            isQuestion: true,
            confidence: 0.5,
            refinedQuery: candidate.rawText,
            topicTags: [],
            fallback: true,
          });
        })
        .finally(() => {
          this.inFlight--;
          this._drainQueue();
        });
    }
  }

  _onStage2Result(candidate, result) {
    if (!result) result = {};
    // A manual "Ask this" is an explicit user command — never droppable,
    // even if the Stage-2 LLM classifies the typed text as "not a question".
    if (result.isQuestion === false && candidate.trigger !== 'manual') return;

    const refined = result.refinedQuery || candidate.rawText;

    // Dedup + cool-down: suppress near-duplicates of recently emitted queries.
    if (candidate.trigger !== 'manual' && this._isDuplicate(refined)) {
      this.onInfo({ suppressed: refined });
      return;
    }

    const event = {
      questionId: `q_${String(++this.qCounter).padStart(4, '0')}`,
      refinedQuery: refined,
      originalUtterance: candidate.rawText,
      isQuestion: true,
      confidence: result.confidence ?? 0.5,
      topicTags: result.topicTags || [],
      createdAt: new Date().toISOString(),
      trigger: candidate.trigger,
      stage2Fallback: !!result.fallback, // true when no LLM was configured/reachable
    };

    this.recentEmitted.push({ tokens: tokenize(refined), at: Date.now() });
    this.emit(event);
  }

  _isDuplicate(refined) {
    const now = Date.now();
    this.recentEmitted = this.recentEmitted.filter((e) => now - e.at < this.cooldownMs * 3);
    const tokens = tokenize(refined);
    return this.recentEmitted.some(
      (e) => now - e.at < this.cooldownMs && jaccard(tokens, e.tokens) >= this.dedupThreshold
    );
  }

  // -- Sliding context window ------------------------------------------------

  _addTurn(segment) {
    this.context.push({
      speaker: segment.speaker || 'unknown',
      text: segment.text,
      endMs: segment.endMs,
    });
    // Trim: last N turns AND within the time window of the newest turn.
    while (this.context.length > this.contextTurns) this.context.shift();
    const newest = this.context[this.context.length - 1]?.endMs ?? 0;
    this.context = this.context.filter((t) => newest - t.endMs <= this.contextMaxMs);
  }
}
