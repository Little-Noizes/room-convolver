/**
 * Routing engine
 *
 * Implements the explicit source-to-IR routing modes described in the spec.
 * No implicit channel mapping. Every routing decision is documented.
 *
 * All functions take pre-aligned Float32Arrays at the same sample rate.
 */

import { convolveChannel } from '../convolution/partitionedConvolution.js';
import type { RoutingMode } from '../../models/types.js';

export interface RouteInput {
  sourceChannels: Float32Array[];
  irChannels: Float32Array[];
  mode: RoutingMode;
  monoSumLaw: 'linear' | 'equal-power';
  onProgress?: (fraction: number) => void;
}

export interface RouteOutput {
  channels: Float32Array[];
  outputDescription: string;
}

/**
 * Perform convolution routing according to the explicit mode.
 * Returns output channels and a description of what was done.
 */
export function route(input: RouteInput): RouteOutput {
  const { sourceChannels, irChannels, mode, monoSumLaw, onProgress } = input;
  const Ns = sourceChannels.length;
  const Ni = irChannels.length;

  let channels: Float32Array[];
  let outputDescription: string;

  switch (mode) {
    case 'mono-mono': {
      assertChannels(Ns, 1, 'source', mode);
      assertChannels(Ni, 1, 'IR', mode);
      channels = [convolveChannel(sourceChannels[0], irChannels[0], onProgress)];
      outputDescription = 'Mono source convolved with mono IR → mono output.';
      break;
    }

    case 'mono-stereo': {
      assertChannels(Ns, 1, 'source', mode);
      assertAtLeast(Ni, 2, 'IR', mode);
      const left  = convolveChannel(sourceChannels[0], irChannels[0], progressSlice(onProgress, 0, 0.5));
      const right = convolveChannel(sourceChannels[0], irChannels[1], progressSlice(onProgress, 0.5, 1));
      channels = [left, right];
      outputDescription = 'Mono source convolved independently with L and R IR channels → stereo output.';
      break;
    }

    case 'mono-binaural': {
      assertChannels(Ns, 1, 'source', mode);
      assertAtLeast(Ni, 2, 'IR', mode);
      const leftEar  = convolveChannel(sourceChannels[0], irChannels[0], progressSlice(onProgress, 0, 0.5));
      const rightEar = convolveChannel(sourceChannels[0], irChannels[1], progressSlice(onProgress, 0.5, 1));
      channels = [leftEar, rightEar];
      outputDescription =
        'Mono source convolved with left-ear and right-ear IR channels independently. ' +
        'Inter-aural timing and level preserved. Intended for headphone playback.';
      break;
    }

    case 'mono-ambisonic': {
      assertChannels(Ns, 1, 'source', mode);
      // Convolve mono source with every Ambisonic IR channel
      channels = irChannels.map((irCh, i) => {
        const frac = i / irChannels.length;
        return convolveChannel(sourceChannels[0], irCh, progressSlice(onProgress, frac, (i + 1) / irChannels.length));
      });
      outputDescription =
        `Mono source convolved independently with all ${irChannels.length} Ambisonic IR channels. ` +
        'Channel order and normalisation preserved from the loaded IR.';
      break;
    }

    case 'stereo-direct': {
      assertAtLeast(Ns, 2, 'source', mode);
      assertAtLeast(Ni, 2, 'IR', mode);
      const l = convolveChannel(sourceChannels[0], irChannels[0], progressSlice(onProgress, 0, 0.5));
      const r = convolveChannel(sourceChannels[1], irChannels[1], progressSlice(onProgress, 0.5, 1));
      channels = [l, r];
      outputDescription =
        'Stereo direct pairing: source L convolved with IR L, source R convolved with IR R. ' +
        'Simple but not physically rigorous — appropriate for symmetric capture setups.';
      break;
    }

    case 'stereo-monosum-stereo': {
      assertAtLeast(Ns, 2, 'source', mode);
      assertAtLeast(Ni, 2, 'IR', mode);
      const mono = monoSum(sourceChannels[0], sourceChannels[1], monoSumLaw);
      const sl   = convolveChannel(mono, irChannels[0], progressSlice(onProgress, 0, 0.5));
      const sr   = convolveChannel(mono, irChannels[1], progressSlice(onProgress, 0.5, 1));
      channels = [sl, sr];
      outputDescription =
        `Stereo source summed to mono (${monoSumLaw} law), then convolved with stereo IR. ` +
        'Provides a physically interpretable room convolution at the cost of source stereo width.';
      break;
    }

    case 'stereo-monosum-binaural': {
      assertAtLeast(Ns, 2, 'source', mode);
      assertAtLeast(Ni, 2, 'IR', mode);
      const mono = monoSum(sourceChannels[0], sourceChannels[1], monoSumLaw);
      const bl   = convolveChannel(mono, irChannels[0], progressSlice(onProgress, 0, 0.5));
      const br   = convolveChannel(mono, irChannels[1], progressSlice(onProgress, 0.5, 1));
      channels = [bl, br];
      outputDescription =
        `Stereo source summed to mono (${monoSumLaw} law), then convolved with binaural IR. ` +
        'Recommended for binaural rendering of stereo sources.';
      break;
    }

    case 'stereo-monosum-ambisonic': {
      assertAtLeast(Ns, 2, 'source', mode);
      const mono = monoSum(sourceChannels[0], sourceChannels[1], monoSumLaw);
      channels = irChannels.map((irCh, i) => {
        const frac = i / irChannels.length;
        return convolveChannel(mono, irCh, progressSlice(onProgress, frac, (i + 1) / irChannels.length));
      });
      outputDescription =
        `Stereo source summed to mono (${monoSumLaw} law), then convolved with Ambisonic IR (${irChannels.length} channels).`;
      break;
    }

    case 'stereo-true': {
      // True stereo requires exactly 4 IR channels: LL, LR, RL, RR
      // y_L = x_L * IR_LL + x_R * IR_RL
      // y_R = x_L * IR_LR + x_R * IR_RR
      assertAtLeast(Ns, 2, 'source', mode);
      if (Ni < 4) {
        throw new Error(
          `True-stereo convolution requires 4 IR channels (LL, LR, RL, RR) but only ${Ni} were provided. ` +
          'Use stereo-direct or stereo-monosum-stereo for two-channel IRs.'
        );
      }
      const [irLL, irLR, irRL, irRR] = irChannels;
      const yL_from_L = convolveChannel(sourceChannels[0], irLL, progressSlice(onProgress, 0, 0.25));
      const yR_from_L = convolveChannel(sourceChannels[0], irLR, progressSlice(onProgress, 0.25, 0.5));
      const yL_from_R = convolveChannel(sourceChannels[1], irRL, progressSlice(onProgress, 0.5, 0.75));
      const yR_from_R = convolveChannel(sourceChannels[1], irRR, progressSlice(onProgress, 0.75, 1));

      const outLen = yL_from_L.length;
      const outL   = new Float32Array(outLen);
      const outR   = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        outL[i] = yL_from_L[i] + yL_from_R[i];
        outR[i] = yR_from_L[i] + yR_from_R[i];
      }
      channels = [outL, outR];
      outputDescription =
        'True-stereo convolution: four transfer paths (LL, LR, RL, RR). ' +
        'y_L = x_L * IR_LL + x_R * IR_RL; y_R = x_L * IR_LR + x_R * IR_RR.';
      break;
    }

    default:
      throw new Error(`Unrecognised routing mode: ${mode as string}`);
  }

  return { channels, outputDescription };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sum two channels to mono.
 * linear: x_mono = (L + R) / 2  — preserves level of a mono-compatible signal
 * equal-power: x_mono = (L + R) / sqrt(2)  — preserves power of independent signals
 */
function monoSum(
  left: Float32Array,
  right: Float32Array,
  law: 'linear' | 'equal-power'
): Float32Array {
  const len  = Math.min(left.length, right.length);
  const out  = new Float32Array(len);
  const gain = law === 'equal-power' ? 1 / Math.SQRT2 : 0.5;
  for (let i = 0; i < len; i++) {
    out[i] = (left[i] + right[i]) * gain;
  }
  return out;
}

function assertChannels(actual: number, expected: number, label: string, mode: RoutingMode): void {
  if (actual !== expected) {
    throw new Error(
      `Routing mode "${mode}" requires exactly ${expected} ${label} channel(s), but ${actual} were provided.`
    );
  }
}

function assertAtLeast(actual: number, min: number, label: string, mode: RoutingMode): void {
  if (actual < min) {
    throw new Error(
      `Routing mode "${mode}" requires at least ${min} ${label} channel(s), but only ${actual} were provided.`
    );
  }
}

/** Slice progress reporting into a sub-range [start, end) */
function progressSlice(
  onProgress: ((f: number) => void) | undefined,
  start: number,
  end: number
): ((f: number) => void) | undefined {
  if (!onProgress) return undefined;
  return (f: number) => onProgress(start + f * (end - start));
}

/** Return available routing modes for the given source/IR channel counts */
export function availableRoutingModes(
  sourceChannelCount: number,
  irChannelCount: number
): RoutingMode[] {
  const modes: RoutingMode[] = [];

  if (sourceChannelCount === 1) {
    if (irChannelCount === 1) modes.push('mono-mono');
    if (irChannelCount >= 2) modes.push('mono-stereo', 'mono-binaural');
    if (irChannelCount === 4 || irChannelCount === 9 || irChannelCount === 16) {
      modes.push('mono-ambisonic');
    }
  }

  if (sourceChannelCount >= 2) {
    if (irChannelCount >= 2) {
      modes.push('stereo-direct', 'stereo-monosum-stereo', 'stereo-monosum-binaural');
    }
    if (irChannelCount >= 4) {
      modes.push('stereo-true');
    }
    if (irChannelCount === 4 || irChannelCount === 9 || irChannelCount === 16) {
      modes.push('stereo-monosum-ambisonic');
    }
  }

  return modes;
}
