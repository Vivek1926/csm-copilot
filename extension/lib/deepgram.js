// Deepgram STT client. Same contract as the Whisper worker: one finalized
// VAD utterance in (16 kHz mono Float32), transcript text out — so the rest
// of the pipeline (detector, lexicon, panel) is untouched by the engine swap.
//
// Uses the prerecorded REST endpoint with raw linear16 PCM.

// Hackathon demo key — override in panel Settings (chrome.storage
// 'deepgramApiKey'). Rotate this key after the demo; it is in source.
const DEFAULT_DG_KEY = '01060c81de87383d4021a68a59bf3be1af2f4c37';

const DG_URL = 'https://api.deepgram.com/v1/listen';
const REQUEST_TIMEOUT_MS = 20000;

// Spoken-language handling: the consultant selects the call's LANGUAGE PAIR
// and the client identifies, per utterance, which of the two is being spoken.
//
// - 'en-hi' (default): one request with detection RESTRICTED to en+hi
//   (repeated detect_language params — verified live). Open-set detection
//   labeled short utterances as Swedish/Dutch/Indonesian and transcribed
//   garbage; restricting the candidates makes that impossible.
// - 'en-ar': 'ar' is not a valid detection candidate (the API 400s on it),
//   so this mode runs TWO PINNED passes in parallel (language=en and
//   language=ar) and keeps the higher-confidence transcript. No detection
//   involved. Same latency (parallel), 2x calls.
//
// All request combos verified live (HTTP 200), including keyterm boosts.
const MODEL = 'nova-3';
export const SUPPORTED_LANGUAGES = new Set(['en-hi', 'en-ar']);
const DEFAULT_LANGUAGE = 'en-hi';

/** Float32 [-1,1] → Int16 PCM (linear16). */
export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Unique single-word boost keywords from the domain-term list. */
export function keywordsFromTerms(terms, max = 25) {
  const words = new Set();
  for (const term of terms || []) {
    for (const w of String(term).split(/\s+/)) {
      const clean = w.replace(/[^A-Za-z0-9-]/g, '');
      if (clean.length > 3) words.add(clean);
    }
  }
  return [...words].slice(0, max);
}

export class DeepgramClient {
  /** @param {() => object} configProvider returns {deepgramApiKey} (pushed
   *  config — offscreen docs can't read chrome.storage). */
  constructor(configProvider) {
    this.configProvider = configProvider || (() => ({}));
  }

  _apiKey() {
    const cfg = this.configProvider() || {};
    return cfg.deepgramApiKey || DEFAULT_DG_KEY;
  }

  /**
   * @param {Float32Array} audio  16 kHz mono utterance
   * @param {string[]} [keywords] boost words (domain terms)
   * @returns {{text: string, confidence: number|null, language: string|null}}
   *
   * Language pair from config.sttLanguage (panel Settings): 'en-hi'
   * (default) or 'en-ar'. Per utterance, the client identifies which of the
   * pair is being spoken.
   */
  async transcribe(audio, keywords = []) {
    const cfg = this.configProvider() || {};
    const mode = SUPPORTED_LANGUAGES.has(cfg.sttLanguage)
      ? cfg.sttLanguage
      : DEFAULT_LANGUAGE;
    const pcm = floatTo16BitPCM(audio);

    if (mode === 'en-hi') {
      // Single request, detection restricted to exactly these candidates.
      return await this._request(pcm, MODEL, ['en', 'hi'], keywords);
    }

    // en-ar: two pinned passes in parallel; the more confident wins.
    const [en, ar] = await Promise.allSettled([
      this._request(pcm, MODEL, 'en', keywords),
      this._request(pcm, MODEL, 'ar', keywords),
    ]);
    const enRes = en.status === 'fulfilled' ? en.value : null;
    const arRes = ar.status === 'fulfilled' ? ar.value : null;

    if (!enRes && !arRes) throw en.reason || ar.reason;
    if (!enRes || !enRes.text) return arRes || enRes;
    if (!arRes || !arRes.text) return enRes;
    // Ties go to English (Arabic transliteration of English speech can score
    // moderately, but real Arabic speech scores decisively higher on ar).
    return (arRes.confidence ?? 0) > (enRes.confidence ?? 0) ? arRes : enRes;
  }

  async _request(pcm, model, language, keywords) {
    const params = new URLSearchParams({
      model,
      smart_format: 'true',
      punctuate: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
    });
    if (Array.isArray(language)) {
      // Candidate-restricted detection: repeated detect_language params.
      for (const lang of language) params.append('detect_language', lang);
    } else {
      params.set('language', language);
    }
    // keyterm boosting verified live for en/hi/ar and with detect_language.
    for (const kw of keywords) params.append('keyterm', kw);
    console.log(
      `Deepgram request: ${model} / ${Array.isArray(language) ? `detect(${language.join('+')})` : language}`
    );

    const res = await fetch(`${DG_URL}?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this._apiKey()}`,
        'Content-Type': 'application/octet-stream',
      },
      body: pcm.buffer,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Deepgram ${res.status}: ${body.slice(0, 120)}`);
    }

    const data = await res.json();
    const channel = data?.results?.channels?.[0];
    const alt = channel?.alternatives?.[0];
    return {
      text: (alt?.transcript || '').trim(),
      confidence: typeof alt?.confidence === 'number' ? alt.confidence : null,
      // Which language this utterance was heard in (from detection, or the
      // pinned setting).
      language: channel?.detected_language || (Array.isArray(language) ? null : language),
    };
  }
}
