// Domain-term correction: Whisper can't spell out-of-vocabulary product names
// ("Seclore" → "secular", "the clue", "cyclore"; "policy server" → "police,
// sir"). No STT model fixes this — brand names aren't in any training set —
// so we fuzzy-match transcript n-grams against a lexicon of known terms and
// rewrite them to canonical form before anything downstream sees the text.

export const DEFAULT_TERMS = [
  'Seclore Online',
  'Seclore',
  'policy server',
  'desktop client',
  'policy federation',
  'digital rights management',
  'data classification',
  'usage policy',
  'SAML',
  'SSO',
  'DRM',
];

function normWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * Build a correction function from a list of canonical terms.
 * Matching rules (tuned on real Whisper mishearings):
 * - Single-word term: window word must be >= 0.7 similar and >= 4 chars.
 * - Multi-word term: average word similarity >= 0.58 AND at least one word
 *   is a near-exact "anchor" (>= 0.8). The anchor (e.g. "online", "policy")
 *   is what licenses a loose match on the other word ("claw" -> "Seclore",
 *   "sir" -> "server").
 * Longest terms are tried first; corrected spans are not re-matched.
 */
export function createCorrector(terms) {
  const entries = (terms || [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map((t) => ({ canonical: t, words: t.split(/\s+/).map(normWord) }))
    .filter((e) => e.words.length > 0 && e.words.every(Boolean))
    .sort((a, b) => b.words.length - a.words.length);

  return function correct(text) {
    if (!text || entries.length === 0) return text;

    // Interleaved word/separator tokens so punctuation survives.
    const tokens = text.split(/(\s+)/);
    const wordIdx = [];
    tokens.forEach((tok, i) => {
      if (tok && !/^\s+$/.test(tok)) wordIdx.push(i);
    });
    const consumed = new Array(tokens.length).fill(false);

    for (const entry of entries) {
      const n = entry.words.length;
      for (let wi = 0; wi + n <= wordIdx.length; wi++) {
        const idxs = wordIdx.slice(wi, wi + n);
        if (idxs.some((i) => consumed[i])) continue;

        const winWords = idxs.map((i) => normWord(tokens[i]));
        const sims = entry.words.map((tw, k) => similarity(tw, winWords[k]));
        const avg = sims.reduce((a, b) => a + b, 0) / n;
        const anchor = Math.max(...sims);

        let ok;
        if (n === 1) {
          ok = sims[0] >= 0.7 && winWords[0].length >= 4;
        } else {
          // Every fuzzy-matched word must be a real word, not "a"/"is".
          const substantive = winWords.every((w, k) => sims[k] >= 0.8 || w.length >= 3);
          ok = avg >= 0.58 && anchor >= 0.8 && substantive;
        }
        if (!ok) continue;

        // Rewrite the span, keeping the last word's trailing punctuation.
        const trailing = (tokens[idxs[n - 1]].match(/[^a-zA-Z0-9]+$/) || [''])[0];
        tokens[idxs[0]] = entry.canonical + trailing;
        for (let i = idxs[0] + 1; i <= idxs[n - 1]; i++) tokens[i] = '';
        idxs.forEach((i) => (consumed[i] = true));
      }
    }

    return tokens.join('').replace(/[ \t]+/g, ' ').trim();
  };
}
