// Answer retrieval: sends the refined question to the Seclore Astra chat API
// (the flow prototyped in test.py — create-chat-session once, then
// send-chat-message per question) and returns the answer text for the card.
//
// One chat session is reused for the whole capture session (matches test.py;
// multi-turn context can help follow-up questions). Concurrency is capped and
// in-flight calls are NEVER cancelled — each question keeps its own card.

const DEFAULT_BASE_URL = 'https://astra.seclore.com';
const DEFAULT_ANSWER_PERSONA = 2;
const REQUEST_TIMEOUT_MS = 45000;

// Appended to every question so answers fit the card during a live call —
// the consultant needs scannable facts, not essay padding. Non-English
// questions (Hindi/Arabic calls) are translated before the knowledge search
// so retrieval runs against the English documentation, and the answer is
// always in English for the consultant.
const ANSWER_STYLE_INSTRUCTION =
  'If the question above is not in English, first translate it to English, then answer. ' +
  'Always search and answer in English. ' +
  'Give me a to-the-point answer without filler sentences.';

export class AnswerClient {
  /**
   * @param {() => object} configProvider returns {astraBaseUrl, astraApiKey,
   *   answerPersonaId} — pushed config; offscreen docs can't read storage.
   * @param {number} [maxConcurrent]
   */
  constructor(configProvider, maxConcurrent = 3) {
    this.configProvider = configProvider;
    this.maxConcurrent = maxConcurrent;
    this.chatSessionId = null;
    this.inFlight = 0;
    this.queue = [];
  }

  _config() {
    const cfg = this.configProvider ? this.configProvider() || {} : {};
    return {
      baseUrl: (cfg.astraBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, ''),
      apiKey: cfg.astraApiKey || '',
      personaId: Number(cfg.answerPersonaId) || DEFAULT_ANSWER_PERSONA,
    };
  }

  /**
   * Queue an answer lookup. onResult is always called exactly once with
   * {ok: true, answer} or {ok: false, error} — this never throws.
   */
  getAnswer(question, onResult) {
    this.queue.push({ question, onResult });
    this._drain();
  }

  _drain() {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      this.inFlight++;
      this._fetchAnswer(job.question)
        .then((answer) => job.onResult({ ok: true, answer }))
        .catch((err) => job.onResult({ ok: false, error: String(err?.message || err) }))
        .finally(() => {
          this.inFlight--;
          this._drain();
        });
    }
  }

  async _fetchAnswer(question) {
    const cfg = this._config();
    if (!cfg.apiKey) {
      throw new Error('No Astra API key configured (panel Settings).');
    }

    const sessionId = await this._ensureSession(cfg);
    const res = await fetch(`${cfg.baseUrl}/api/chat/send-chat-message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        message: `${question}\n\n${ANSWER_STYLE_INSTRUCTION}`,
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) this.chatSessionId = null;
    if (!res.ok) throw new Error(`Astra send-chat-message ${res.status}`);

    const data = await res.json();
    const answer = data.answer_citationless || data.answer || '';
    if (!answer) throw new Error('Astra returned an empty answer.');
    return answer;
  }

  async _ensureSession(cfg) {
    if (this.chatSessionId) return this.chatSessionId;
    const res = await fetch(`${cfg.baseUrl}/api/chat/create-chat-session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ persona_id: cfg.personaId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Astra create-chat-session ${res.status}`);
    const data = await res.json();
    this.chatSessionId = data.chat_session_id;
    return this.chatSessionId;
  }
}
