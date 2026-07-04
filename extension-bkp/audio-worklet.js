// AudioWorkletProcessor: runs inside a 16 kHz AudioContext (Chrome resamples
// the tab stream for us), mixes to mono, batches ~100 ms of samples per
// message to keep the message rate low, and posts Float32 frames to the VAD.

class PcmFramesProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batchSize = 1600; // 100 ms @ 16 kHz
    this.buffer = new Float32Array(this.batchSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const channels = input;
    const len = channels[0].length; // 128-sample render quantum

    for (let i = 0; i < len; i++) {
      let sample = 0;
      for (let c = 0; c < channels.length; c++) sample += channels[c][i];
      this.buffer[this.offset++] = sample / channels.length;

      if (this.offset === this.batchSize) {
        const out = this.buffer;
        this.buffer = new Float32Array(this.batchSize);
        this.offset = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pcm-frames', PcmFramesProcessor);
