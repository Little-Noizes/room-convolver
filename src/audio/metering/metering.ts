/**
 * Metering and impulse-response analysis
 *
 * Provides:
 *   - Peak and RMS measurement
 *   - Onset detection (energy threshold)
 *   - Noise floor estimation
 *   - Clipping detection
 */

export function measurePeakLinear(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

export function measureRMS(channels: Float32Array[], frameStart = 0, frameEnd?: number): number {
  let sumSq = 0;
  let count = 0;
  for (const ch of channels) {
    const end = frameEnd ?? ch.length;
    for (let i = frameStart; i < end; i++) {
      sumSq += ch[i] * ch[i];
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

export function linearToDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Estimate noise floor from the last 10% of the signal (assumes decay).
 * Returns value in dBFS.
 */
export function estimateNoiseFloor(channel: Float32Array): number {
  const tailStart = Math.floor(channel.length * 0.9);
  const tail = channel.subarray(tailStart);
  return linearToDb(measureRMS([tail]));
}

/**
 * Estimate IR onset frame using an energy threshold.
 * Searches for the first frame where energy exceeds threshold * peak energy.
 *
 * Returns frame index or 0 if no onset detected above threshold.
 */
export function detectOnset(channel: Float32Array, thresholdFraction = 0.01): number {
  let peak = 0;
  for (let i = 0; i < channel.length; i++) {
    const a = Math.abs(channel[i]);
    if (a > peak) peak = a;
  }
  const threshold = peak * thresholdFraction;
  for (let i = 0; i < channel.length; i++) {
    if (Math.abs(channel[i]) >= threshold) return i;
  }
  return 0;
}

/** Returns true if any sample is at or above 0 dBFS (absolute value >= 1.0) */
export function hasClipping(channels: Float32Array[]): boolean {
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) >= 1.0) return true;
    }
  }
  return false;
}

/** Count samples exceeding the threshold */
export function countClippedSamples(channels: Float32Array[], threshold = 1.0): number {
  let count = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) >= threshold) count++;
    }
  }
  return count;
}

/**
 * Apply a gain scalar to all channels in-place.
 * Does NOT clamp — caller is responsible for checking peaks first.
 */
export function applyGain(channels: Float32Array[], gainLinear: number): void {
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= gainLinear;
  }
}

/**
 * Return new channels with gain applied (non-destructive).
 */
export function gainChannels(channels: Float32Array[], gainLinear: number): Float32Array[] {
  return channels.map(ch => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * gainLinear;
    return out;
  });
}

/**
 * Apply a linear fade-in of fadeFrames at the start of each channel.
 */
export function applyFadeIn(channels: Float32Array[], fadeFrames: number): void {
  const f = Math.min(fadeFrames, channels[0]?.length ?? 0);
  for (const ch of channels) {
    for (let i = 0; i < f; i++) ch[i] *= i / f;
  }
}

/**
 * Apply a linear fade-out of fadeFrames at the end of each channel.
 */
export function applyFadeOut(channels: Float32Array[], fadeFrames: number): void {
  const len = channels[0]?.length ?? 0;
  const f   = Math.min(fadeFrames, len);
  for (const ch of channels) {
    for (let i = 0; i < f; i++) ch[len - 1 - i] *= i / f;
  }
}

/** Remove DC offset from a single channel in-place. */
export function removeDC(channel: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) sum += channel[i];
  const mean = sum / channel.length;
  for (let i = 0; i < channel.length; i++) channel[i] -= mean;
}

/**
 * Simple one-pole high-pass filter, applied in-place.
 * cutoffHz: the -3 dB frequency.
 * sampleRate: sample rate of the signal.
 */
export function applyHighPass(channel: Float32Array, cutoffHz: number, sampleRate: number): void {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);
  let prev = channel[0];
  let prevFiltered = 0;
  for (let i = 1; i < channel.length; i++) {
    const curr = channel[i];
    prevFiltered = alpha * (prevFiltered + curr - prev);
    channel[i - 1] = prevFiltered;
    prev = curr;
  }
}

/** Trim a set of channels to [startFrame, endFrame). All channels trimmed identically. */
export function trimChannels(
  channels: Float32Array[],
  startFrame: number,
  endFrame: number
): Float32Array[] {
  const s = Math.max(0, startFrame);
  const e = Math.min(channels[0]?.length ?? 0, endFrame);
  return channels.map(ch => ch.slice(s, e));
}
