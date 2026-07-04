// Voice-activity segmentation: a simple RMS energy gate with an adaptive
// noise floor. Cuts the 16 kHz stream into complete utterances so Whisper
// (a batch model) only ever sees real speech — never dead air, which it
// hallucinates on. Swappable for Silero ONNX later behind the same callbacks.

const FRAME_SIZE = 512; // 32 ms @ 16 kHz

export class VAD {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate]
   * @param {() => void} [opts.onSpeechStart]   fired once when an utterance opens
   * @param {(audio: Float32Array, startMs: number, endMs: number) => void} opts.onSegment
   */
  constructor({ sampleRate = 16000, onSpeechStart, onSegment } = {}) {
    this.sampleRate = sampleRate;
    this.onSpeechStart = onSpeechStart || (() => {});
    this.onSegment = onSegment || (() => {});

    // Tunables. The gate errs toward sensitivity: with cloud STT a false
    // trigger just returns an empty transcript (dropped), but a missed quiet
    // speaker loses a real question.
    this.minThreshold = 0.006;    // absolute RMS floor for "speech"
    this.noiseMultiplier = 2.5;   // speech must exceed noiseFloor * this
    this.onFrames = 3;            // ~96 ms of speech to open a segment
    this.offFrames = 22;          // ~700 ms of silence to close it
    this.prerollFrames = 8;       // ~250 ms kept from before speech opened
    this.minSpeechMs = 350;       // discard blips shorter than this
    this.maxSegmentMs = 28000;    // force-cut before Whisper's 30 s window
    // Continuous talkers never leave a 700 ms gap. Once a segment is already
    // long, cut at a brief inter-sentence pause instead, so questions surface
    // in seconds rather than waiting for the force-cut.
    this.softSilenceFrames = 10;  // ~320 ms pause…
    this.softSplitMs = 8000;      // …closes a segment that is ≥ 8 s long

    // State
    this.noiseFloor = 0.004;
    this.inSpeech = false;
    this.speechRun = 0;
    this.silenceRun = 0;
    this.preroll = [];            // ring of recent frames (Float32Array each)
    this.segment = [];            // frames of the open utterance
    this.segmentSpeechFrames = 0; // frames actually above threshold (not preroll/tail)
    this.segmentStartSample = 0;
    this.totalSamples = 0;        // absolute sample clock since capture start

    this._residual = new Float32Array(0); // partial frame between push() calls
  }

  /** Feed arbitrary-length Float32 audio (from the worklet). */
  push(chunk) {
    // Stitch with residual, then walk complete FRAME_SIZE frames.
    let data;
    if (this._residual.length > 0) {
      data = new Float32Array(this._residual.length + chunk.length);
      data.set(this._residual, 0);
      data.set(chunk, this._residual.length);
    } else {
      data = chunk;
    }

    let i = 0;
    for (; i + FRAME_SIZE <= data.length; i += FRAME_SIZE) {
      this._processFrame(data.subarray(i, i + FRAME_SIZE));
    }
    this._residual = data.slice(i);
  }

  /** Flush any open utterance (call on stop). */
  flush() {
    if (this.inSpeech) this._closeSegment();
  }

  _processFrame(frame) {
    const rms = this._rms(frame);
    const threshold = Math.min(
      Math.max(this.noiseFloor * this.noiseMultiplier, this.minThreshold),
      0.1
    );
    const isSpeech = rms > threshold;

    if (!this.inSpeech) {
      // Track the noise floor only while silent.
      if (!isSpeech) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;

      this._pushPreroll(frame);

      if (isSpeech) {
        this.speechRun++;
        if (this.speechRun >= this.onFrames) this._openSegment();
      } else {
        this.speechRun = 0;
      }
    } else {
      this.segment.push(frame.slice());

      if (isSpeech) {
        this.silenceRun = 0;
        this.segmentSpeechFrames++;
      } else {
        this.silenceRun++;
        const segMs = (this.segment.length * FRAME_SIZE * 1000) / this.sampleRate;
        if (
          this.silenceRun >= this.offFrames ||
          (this.silenceRun >= this.softSilenceFrames && segMs >= this.softSplitMs)
        ) {
          this._closeSegment();
        }
      }

      // Long monologue: force a cut so Whisper never sees > ~28 s.
      const segMs = (this.segment.length * FRAME_SIZE * 1000) / this.sampleRate;
      if (this.inSpeech && segMs >= this.maxSegmentMs) {
        this._closeSegment(/* keepOpen */ true);
      }
    }

    this.totalSamples += FRAME_SIZE;
  }

  _openSegment() {
    this.inSpeech = true;
    this.silenceRun = 0;
    this.segmentSpeechFrames = this.onFrames; // the frames that tripped the gate
    // Utterance starts at the beginning of the preroll.
    this.segmentStartSample =
      this.totalSamples - this.preroll.length * FRAME_SIZE;
    this.segment = this.preroll.map((f) => f.slice());
    this.preroll = [];
    this.onSpeechStart();
  }

  _closeSegment(keepOpen = false) {
    let frames = this.segment;
    const closingSilence = this.silenceRun;
    const speechFrames = this.segmentSpeechFrames;
    this.segment = [];
    this.segmentSpeechFrames = 0;
    this.speechRun = 0;
    this.silenceRun = 0;
    if (!keepOpen) this.inSpeech = false;
    else this.segmentStartSample = this.totalSamples; // continuation segment

    // Actual speech (not preroll, not the silence tail) must clear the bar.
    const speechMs = (speechFrames * FRAME_SIZE * 1000) / this.sampleRate;
    if (speechMs < this.minSpeechMs) return; // blip — drop

    // Trim most of the trailing silence (keep ~190 ms of hang for natural
    // word endings) — never feed Whisper avoidable dead air.
    const hangFrames = 6;
    const trim = Math.max(0, closingSilence - hangFrames);
    if (trim > 0) frames = frames.slice(0, frames.length - trim);

    const totalLen = frames.length * FRAME_SIZE;
    const audio = new Float32Array(totalLen);
    frames.forEach((f, idx) => audio.set(f, idx * FRAME_SIZE));

    const startMs = Math.round((this.segmentStartSample * 1000) / this.sampleRate);
    const endMs = Math.round(startMs + (totalLen * 1000) / this.sampleRate);
    this.onSegment(audio, startMs, endMs);
  }

  _pushPreroll(frame) {
    this.preroll.push(frame.slice());
    if (this.preroll.length > this.prerollFrames) this.preroll.shift();
  }

  _rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  }
}
