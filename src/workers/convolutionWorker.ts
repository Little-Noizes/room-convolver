/**
 * Convolution Web Worker
 *
 * Runs the partitioned FFT convolution off the main thread.
 * Communicates via postMessage with transferable ArrayBuffers to avoid copying.
 *
 * Message protocol:
 *   → ConvolveRequest
 *   ← ConvolveProgress (multiple)
 *   ← ConvolveResult (final)
 *   ← ConvolveError (on failure)
 */

import { convolveChannel } from '../audio/convolution/partitionedConvolution';

export interface ConvolveRequest {
  type: 'convolve';
  sourceChannels: Float32Array[];   // one per source channel
  irChannels: Float32Array[];       // one per IR channel
  routingMode: string;
  monoSumLaw: 'linear' | 'equal-power';
  requestId: string;
}

export interface ConvolveProgress {
  type: 'progress';
  requestId: string;
  stage: string;
  fraction: number;
}

export interface ConvolveResult {
  type: 'result';
  requestId: string;
  outputChannels: Float32Array[];
}

export interface ConvolveError {
  type: 'error';
  requestId: string;
  message: string;
}

// ── Worker message handler ────────────────────────────────────────────────────

self.addEventListener('message', (event: MessageEvent<ConvolveRequest>) => {
  const msg = event.data;
  if (msg.type !== 'convolve') return;

  const { requestId, sourceChannels, irChannels, routingMode, monoSumLaw } = msg;

  const progress = (stage: string, fraction: number) => {
    const p: ConvolveProgress = { type: 'progress', requestId, stage, fraction };
    self.postMessage(p);
  };

  try {
    progress('Starting convolution', 0);
    const outputChannels = routeAndConvolve(
      sourceChannels, irChannels, routingMode, monoSumLaw, progress
    );

    const result: ConvolveResult = { type: 'result', requestId, outputChannels };
    const transferables = outputChannels.map(ch => ch.buffer as ArrayBuffer);
    self.postMessage(result, { transfer: transferables });
  } catch (err) {
    const error: ConvolveError = {
      type: 'error',
      requestId,
      message: (err as Error).message,
    };
    self.postMessage(error);
  }
});

function routeAndConvolve(
  sourceChannels: Float32Array[],
  irChannels: Float32Array[],
  mode: string,
  monoSumLaw: 'linear' | 'equal-power',
  progress: (stage: string, fraction: number) => void
): Float32Array[] {
  const Ni = irChannels.length;

  switch (mode) {
    case 'mono-mono':
      return [convolveChannel(sourceChannels[0], irChannels[0], f => progress('Convolving', f))];

    case 'mono-stereo':
    case 'mono-binaural': {
      const l = convolveChannel(sourceChannels[0], irChannels[0], f => progress('Convolving L', f * 0.5));
      const r = convolveChannel(sourceChannels[0], irChannels[1], f => progress('Convolving R', 0.5 + f * 0.5));
      return [l, r];
    }

    case 'mono-ambisonic': {
      const out: Float32Array[] = [];
      for (let i = 0; i < Ni; i++) {
        progress(`Convolving ch ${i + 1}/${Ni}`, i / Ni);
        out.push(convolveChannel(sourceChannels[0], irChannels[i]));
      }
      return out;
    }

    case 'stereo-direct': {
      const l = convolveChannel(sourceChannels[0], irChannels[0], f => progress('Convolving L', f * 0.5));
      const r = convolveChannel(sourceChannels[1], irChannels[1], f => progress('Convolving R', 0.5 + f * 0.5));
      return [l, r];
    }

    case 'stereo-monosum-stereo':
    case 'stereo-monosum-binaural': {
      const mono = monoSum(sourceChannels[0], sourceChannels[1], monoSumLaw);
      const l = convolveChannel(mono, irChannels[0], f => progress('Convolving L', f * 0.5));
      const r = convolveChannel(mono, irChannels[1], f => progress('Convolving R', 0.5 + f * 0.5));
      return [l, r];
    }

    case 'stereo-monosum-ambisonic': {
      const mono = monoSum(sourceChannels[0], sourceChannels[1], monoSumLaw);
      const out: Float32Array[] = [];
      for (let i = 0; i < Ni; i++) {
        progress(`Convolving ch ${i + 1}/${Ni}`, i / Ni);
        out.push(convolveChannel(mono, irChannels[i]));
      }
      return out;
    }

    case 'stereo-true': {
      const [irLL, irLR, irRL, irRR] = irChannels;
      const yL_L = convolveChannel(sourceChannels[0], irLL, f => progress('Conv LL', f * 0.25));
      const yR_L = convolveChannel(sourceChannels[0], irLR, f => progress('Conv LR', 0.25 + f * 0.25));
      const yL_R = convolveChannel(sourceChannels[1], irRL, f => progress('Conv RL', 0.5 + f * 0.25));
      const yR_R = convolveChannel(sourceChannels[1], irRR, f => progress('Conv RR', 0.75 + f * 0.25));
      const len  = yL_L.length;
      const outL = new Float32Array(len);
      const outR = new Float32Array(len);
      for (let i = 0; i < len; i++) { outL[i] = yL_L[i] + yL_R[i]; outR[i] = yR_L[i] + yR_R[i]; }
      return [outL, outR];
    }

    default:
      throw new Error(`Worker: unrecognised routing mode "${mode}"`);
  }
}

function monoSum(l: Float32Array, r: Float32Array, law: 'linear' | 'equal-power'): Float32Array {
  const len  = Math.min(l.length, r.length);
  const out  = new Float32Array(len);
  const gain = law === 'equal-power' ? 1 / Math.SQRT2 : 0.5;
  for (let i = 0; i < len; i++) out[i] = (l[i] + r[i]) * gain;
  return out;
}
