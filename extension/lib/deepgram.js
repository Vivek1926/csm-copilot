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

// Spoken-language handling. Speakers on one call may mix Hindi, English and
// Arabic, so the default is per-utterance AUTO-DETECTION: each VAD utterance
// is its own request with detect_language=true, and nova-3 reports which
// language it heard. Manual pins (en/hi/ar) remain for when detection
// misbehaves. All combos verified live (HTTP 200), including keyterm
// alongside detect_language. Candidate-restricted detection is NOT supported
// by the API (400) — detection is open.
const MODEL = 'nova-3';
export const SUPPORTED_LANGUAGES = new Set(['auto', 'en', 'hi', 'ar']);
const DEFAULT_LANGUAGE = 'auto';

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
   * Language mode from config.sttLanguage (panel Settings): 'auto' (default —
   * per-utterance detection, handles Hindi/English/Arabic speakers on the
   * same call) or a pinned 'en' / 'hi' / 'ar'.
   */
  async transcribe(audio, keywords = []) {
    const cfg = this.configProvider() || {};
    const language = SUPPORTED_LANGUAGES.has(cfg.sttLanguage)
      ? cfg.sttLanguage
      : DEFAULT_LANGUAGE;
    const pcm = floatTo16BitPCM(audio);
    return await this._request(pcm, MODEL, language, keywords);
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
    if (language === 'auto') {
      params.set('detect_language', 'true');
    } else {
      params.set('language', language);
    }
    // keyterm boosting verified live for en/hi/ar and with detect_language.
    for (const kw of keywords) params.append('keyterm', kw);
    console.log(`Deepgram request: ${model} / ${language}`);

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
      language: channel?.detected_language || (language === 'auto' ? null : language),
    };
  }
}
