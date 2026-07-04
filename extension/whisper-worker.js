// Whisper inference worker. Runs Transformers.js + ONNX Runtime Web off the
// main/audio threads. WebGPU when available, WASM fallback (single-threaded —
// extension pages are not cross-origin isolated, so no SharedArrayBuffer).
//
// Protocol (postMessage):
//   in : { type: 'init', modelId? }
//   out: { type: 'progress', status, file, progress, loaded, total }
//   out: { type: 'ready', device }
//   in : { type: 'transcribe', id, audio: Float32Array }   (16 kHz mono)
//   out: { type: 'result', id, text, sttMs } | { type: 'result', id, error }

import { pipeline, env } from './lib/vendor/transformers.min.js';

// Serve the ORT wasm/jsep runtime from the vendored copy (MV3 CSP: no CDN code).
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('./lib/vendor/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

// whisper-small is markedly better on technical vocabulary than base and
// still real-time on WebGPU (~1.5-2.5s per utterance). Switchable from the
// panel settings; base remains the fast option for weaker machines.
const DEFAULT_MODEL = 'onnx-community/whisper-small';

let transcriber = null;
let queue = Promise.resolve(); // serialize inference — one utterance at a time

async function detectDevice() {
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return 'webgpu';
  } catch {
    /* fall through */
  }
  return 'wasm';
}

async function init(modelId = DEFAULT_MODEL) {
  const device = await detectDevice();
  // Hybrid quantization: full-precision encoder preserves feature quality on
  // technical terms; q4 decoder keeps download and memory reasonable. For
  // whisper-small the fp32 encoder is ~350MB, so use fp16 there (WebGPU
  // handles it natively) — base stays fp32.
  const encoderDtype =
    device !== 'webgpu' ? 'q8' : modelId.includes('small') ? 'fp16' : 'fp32';
  transcriber = await pipeline('automatic-speech-recognition', modelId, {
    device,
    dtype: {
      encoder_model: encoderDtype,
      decoder_model_merged: 'q4',
    },
    progress_callback: (p) => {
      postMessage({
        type: 'progress',
        status: p.status,
        file: p.file,
        progress: p.progress,
        loaded: p.loaded,
        total: p.total,
      });
    },
  });

  // Warm-up run: compiles WebGPU shaders / JITs WASM so the first real
  // utterance isn't slow. Output on silence is garbage by design — discard.
  await transcriber(new Float32Array(8000));

  postMessage({ type: 'ready', device });
}

function transcribe(id, audio) {
  queue = queue.then(async () => {
    const t0 = performance.now();
    try {
      const out = await transcriber(audio, {
        // Force English: multilingual whisper-base otherwise drifts into
        // language guessing ("[Spanish]") on unclear audio.
        language: 'english',
        task: 'transcribe',
        // Curb the classic degenerate repetition loop ("No. No. No. ...")
        // Whisper falls into on noisy or borderline-silent segments.
        repetition_penalty: 1.3,
        no_repeat_ngram_size: 3,
      });
      postMessage({
        type: 'result',
        id,
        text: (out?.text || '').trim(),
        sttMs: Math.round(performance.now() - t0),
      });
    } catch (err) {
      postMessage({ type: 'result', id, error: String(err?.message || err) });
    }
  });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg.modelId).catch((err) =>
      postMessage({ type: 'error', error: String(err?.message || err) })
    );
  } else if (msg.type === 'transcribe') {
    transcribe(msg.id, msg.audio);
  }
};
