// Stage 2 — cheap LLM classify + coreference-resolve + refine, one call.
//
// Backend: the Seclore Astra chat API (config in chrome.storage.local, set
// from the panel's settings — the extension never ships a hardcoded key).
// If no key is configured or the call fails, we degrade gracefully to a
// heuristic-only QuestionEvent (raw text as the query, lower confidence),
// so the demo never dead-ends on a backend hiccup.
//
// The transport is isolated here: to swap Astra for an Anthropic proxy later,
// only _callLLM changes.

const STORAGE_KEYS = ['astraBaseUrl', 'astraApiKey', 'astraPersonaId'];
const DEFAULT_BASE_URL = 'https://astra.seclore.com';

const SYSTEM_INSTRUCTIONS = `You detect whether the customer's latest utterance in a pre-sales call is a technical question that needs a documentation lookup, and if so you rewrite it as a single self-contained query using the recent conversation context.

Respond with STRICT JSON only, no prose, no markdown fences:
{"isQuestion": true|false, "confidence": 0.0-1.0, "refinedQuery": "...", "topicTags": ["..."]}

Rules:
- Resolve pronouns and ellipsis from the context (e.g. "does it support that?" -> "Does the platform support SAML-based SSO for external users?").
- If the utterance is small talk, a statement, filler, or clearly the consultant speaking, return {"isQuestion": false, "confidence": ..., "refinedQuery": "", "topicTags": []}.
- topicTags: 1-4 short technical topic labels.`;

export class Stage2Client {
  /**
   * @param {() => object} [configProvider] returns {astraBaseUrl, astraApiKey,
   *   astraPersonaId}. REQUIRED in the offscreen document — offscreen docs
   *   only get chrome.runtime, so chrome.storage cannot be read there; the
   *   config is pushed in via messages instead (see offscreen.js).
   */
  constructor(configProvider) {
    this.configProvider = configProvider || null;
    this.chatSessionId = null; // lazily created, reused for the capture session
  }

  async _getConfig() {
    let stored = {};
    if (this.configProvider) {
      stored = this.configProvider() || {};
    } else if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      stored = await chrome.storage.local.get(STORAGE_KEYS);
    }
    return {
      baseUrl: (stored.astraBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, ''),
      apiKey: stored.astraApiKey || '',
      personaId: Number(stored.astraPersonaId) || 3,
    };
  }

  /**
   * @param {object} candidate  QuestionCandidate (rawText, context, trigger…)
   * @returns {{isQuestion: boolean, confidence: number, refinedQuery: string,
   *            topicTags: string[], fallback?: boolean}}
   * Never throws — any failure degrades to the heuristic fallback, because a
   * thrown error here silently kills the question card.
   */
  async classifyRefine(candidate) {
    let cfg;
    try {
      cfg = await this._getConfig();
    } catch (err) {
      console.warn('Stage 2 config unavailable, using heuristic fallback', err);
      return this._fallback(candidate);
    }
    if (!cfg.apiKey) return this._fallback(candidate);

    try {
      const raw = await this._callLLM(cfg, this._buildPrompt(candidate));
      const parsed = this._extractJson(raw);
      if (parsed && typeof parsed.isQuestion === 'boolean') {
        return {
          isQuestion: parsed.isQuestion,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
          refinedQuery: parsed.refinedQuery || candidate.rawText,
          topicTags: Array.isArray(parsed.topicTags) ? parsed.topicTags : [],
        };
      }
      return this._fallback(candidate);
    } catch (err) {
      console.warn('Stage 2 LLM call failed, using heuristic fallback', err);
      return this._fallback(candidate);
    }
  }

  /** No LLM available: trust Stage 1, emit the raw utterance as the query. */
  _fallback(candidate) {
    const tags = (candidate.heuristicReasons || [])
      .filter((r) => r.startsWith('keyword:'))
      .map((r) => r.slice('keyword:'.length));
    return {
      isQuestion: true,
      confidence: candidate.trigger === 'manual' ? 0.9 : 0.5,
      refinedQuery: candidate.rawText,
      topicTags: tags,
      fallback: true,
    };
  }

  _buildPrompt(candidate) {
    const contextLines = (candidate.context || [])
      .map((t) => `[${t.speaker}] ${t.text}`)
      .join('\n');
    return `${SYSTEM_INSTRUCTIONS}

Recent conversation (oldest first):
${contextLines || '(no prior context)'}

Latest utterance to evaluate:
"${candidate.rawText}"

JSON:`;
  }

  // -- Astra transport --------------------------------------------------------

  async _callLLM(cfg, prompt) {
    const sessionId = await this._ensureSession(cfg);
    const res = await fetch(`${cfg.baseUrl}/api/chat/send-chat-message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        message: prompt,
        stream: false,
      }),
    });
    if (res.status === 401 || res.status === 403) {
      this.chatSessionId = null; // stale session/key — retry fresh next time
    }
    if (!res.ok) throw new Error(`Astra send-chat-message ${res.status}`);
    return await res.text();
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
    });
    if (!res.ok) throw new Error(`Astra create-chat-session ${res.status}`);
    const data = await res.json();
    this.chatSessionId = data.chat_session_id;
    return this.chatSessionId;
  }

  // -- Tolerant JSON extraction ----------------------------------------------
  // The response may be a plain JSON envelope, raw text, or SSE-style lines.
  // Find the model's {"isQuestion": ...} object wherever it landed.

  _extractJson(raw) {
    // 1. Whole-body JSON envelope? Look for a string field holding the answer.
    let body = raw;
    try {
      const envelope = JSON.parse(raw);
      if (typeof envelope === 'object' && envelope !== null) {
        const candidates = ['message', 'response', 'content', 'answer', 'text', 'data'];
        for (const key of candidates) {
          if (typeof envelope[key] === 'string') {
            body = envelope[key];
            break;
          }
        }
        if (typeof envelope.isQuestion === 'boolean') return envelope; // already the payload
      }
    } catch {
      // Not a JSON envelope — maybe SSE lines; concatenate data chunks.
      if (raw.includes('data:')) {
        body = raw
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .filter((l) => l && l !== '[DONE]')
          .map((l) => {
            try {
              const j = JSON.parse(l);
              return j.message || j.content || j.text || j.delta || '';
            } catch {
              return l;
            }
          })
          .join('');
      }
    }

    // 2. Pull the first {...} block mentioning isQuestion out of the body.
    const match = body.match(/\{[^{}]*"isQuestion"[\s\S]*?\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
}
