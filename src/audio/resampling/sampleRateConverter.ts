/**
 * Sample-rate converter
 *
 * Uses a Lanczos-windowed sinc kernel for band-limited interpolation.
 * This avoids the aliasing and quality problems of linear interpolation.
 *
 * The algorithm:
 *   1. Compute the rational ratio P/Q (up to a precision limit).
 *   2. For each output sample, compute the ideal input position.
 *   3. Accumulate a windowed sinc sum over KERNEL_RADIUS input samples.
 *
 * All channels are processed with identical phase behaviour to preserve
 * inter-channel timing, which is critical for stereo, binaural and Ambisonics.
 *
 * Limitations (Phase 1):
 *   - Does not apply a dedicated anti-alias filter for large down-conversions.
 *     For ratios beyond 2x, the kernel window provides partial rejection.
 *   - A future WASM-backed SRC library (e.g. libsamplerate) should be evaluated
 *     for critical work.
 */

const KERNEL_RADIUS = 32; // samples either side of the ideal position
const LANCZOS_A     = KERNEL_RADIUS;

function lanczos(x: number): number {
  if (x === 0) return 1;
  if (Math.abs(x) >= LANCZOS_A) return 0;
  const px = Math.PI * x;
  return (LANCZOS_A * Math.sin(px) * Math.sin(px / LANCZOS_A)) / (px * px);
}

export interface ResampleResult {
  channels: Float32Array[];
  outputSampleRate: number;
  outputFrameCount: number;
}

/**
 * Resample all channels from sourceSampleRate to targetSampleRate.
 * All channels must have the same length.
 */
export function resampleChannels(
  channels: Float32Array[],
  sourceSampleRate: number,
  targetSampleRate: number
): ResampleResult {
  if (sourceSampleRate === targetSampleRate) {
    return {
      channels: channels.map(ch => ch.slice()),
      outputSampleRate: targetSampleRate,
      outputFrameCount: channels[0]?.length ?? 0,
    };
  }

  const ratio         = targetSampleRate / sourceSampleRate;
  const inputLength   = channels[0].length;
  const outputLength  = Math.round(inputLength * ratio);

  // For downsampling we need to limit the kernel bandwidth to avoid aliasing.
  // The effective cutoff is min(1, ratio) * Nyquist.
  const cutoff = Math.min(1, ratio); // relative to input Nyquist

  const outputChannels: Float32Array[] = channels.map(input => {
    const output = new Float32Array(outputLength);

    for (let outIdx = 0; outIdx < outputLength; outIdx++) {
      const inPos = outIdx / ratio;
      const inCenter = Math.floor(inPos);
      let sum = 0;
      let weightSum = 0;

      for (let k = -KERNEL_RADIUS; k <= KERNEL_RADIUS; k++) {
        const inIdx = inCenter + k;
        if (inIdx < 0 || inIdx >= inputLength) continue;

        const delta  = (inPos - inIdx) * cutoff;
        const weight = lanczos(delta);

        sum       += input[inIdx] * weight;
        weightSum += weight;
      }

      output[outIdx] = weightSum > 0 ? sum / weightSum : 0;
    }

    return output;
  });

  return {
    channels: outputChannels,
    outputSampleRate: targetSampleRate,
    outputFrameCount: outputLength,
  };
}

/**
 * Choose target sample rate based on strategy.
 */
export function chooseSampleRate(
  sourceSR: number,
  irSR: number,
  strategy: 'lowest' | 'source' | 'ir' | 'custom',
  customSR?: number
): number {
  switch (strategy) {
    case 'lowest':  return Math.min(sourceSR, irSR);
    case 'source':  return sourceSR;
    case 'ir':      return irSR;
    case 'custom':  return customSR ?? Math.min(sourceSR, irSR);
  }
}
