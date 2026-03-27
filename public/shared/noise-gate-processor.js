class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = 0.012;
    this.holdDuration = sampleRate * 0.4; // 400ms hold after signal drops
    this.holdCounter = 0;
    this.open = false;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0];

    // RMS energy
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length);

    // Gate logic: open instantly, hold for 180ms after signal drops
    if (rms > this.threshold) {
      this.open = true;
      this.holdCounter = this.holdDuration;
    } else if (this.holdCounter > 0) {
      this.holdCounter -= samples.length;
    } else {
      this.open = false;
    }

    // Pass through or silence
    for (let ch = 0; ch < output.length; ch++) {
      const inp = input[ch] || input[0];
      const out = output[ch];
      if (this.open) {
        out.set(inp);
      } else {
        out.fill(0);
      }
    }

    return true;
  }
}
registerProcessor('noise-gate-processor', NoiseGateProcessor);