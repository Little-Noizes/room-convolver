/**
 * Worker bridge
 *
 * Provides a Promise-based interface to the convolution Web Worker.
 * Falls back to synchronous main-thread processing if Workers are unavailable
 * (e.g. in test environments or restricted contexts).
 */

import type {
  ConvolveRequest,
  ConvolveProgress,
  ConvolveResult,
  ConvolveError,
} from './convolutionWorker';
import { route } from '../audio/routing/routingEngine';
import type { RoutingConfiguration } from '../models/types';

let worker: Worker | null = null;

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./convolutionWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
  }
  return worker;
}

let requestCounter = 0;

export interface WorkerConvolveOptions {
  sourceChannels: Float32Array[];
  irChannels: Float32Array[];
  routing: RoutingConfiguration;
  onProgress?: (stage: string, fraction: number) => void;
}

/**
 * Run convolution, preferring the Web Worker.
 * Returns output channels.
 */
export async function convolveViaWorker(opts: WorkerConvolveOptions): Promise<Float32Array[]> {
  const { sourceChannels, irChannels, routing, onProgress } = opts;
  const w = getWorker();

  if (!w) {
    // Synchronous fallback — main thread
    onProgress?.('Convolving (main thread)', 0);
    const result = route({
      sourceChannels,
      irChannels,
      mode: routing.mode,
      monoSumLaw: routing.monoSumLaw,
      onProgress: (f) => onProgress?.('Convolving', f),
    });
    return result.channels;
  }

  return new Promise((resolve, reject) => {
    const requestId = `req-${++requestCounter}`;

    const handler = (event: MessageEvent<ConvolveProgress | ConvolveResult | ConvolveError>) => {
      const msg = event.data;
      if (msg.requestId !== requestId) return;

      if (msg.type === 'progress') {
        onProgress?.(msg.stage, msg.fraction);
      } else if (msg.type === 'result') {
        w.removeEventListener('message', handler);
        resolve(msg.outputChannels);
      } else if (msg.type === 'error') {
        w.removeEventListener('message', handler);
        reject(new Error(msg.message));
      }
    };

    w.addEventListener('message', handler);

    // Transfer source and IR buffers to avoid copying large arrays.
    // Copies are made here so the caller retains its originals.
    const srcCopies = sourceChannels.map(ch => ch.slice());
    const irCopies  = irChannels.map(ch => ch.slice());
    const transferables = [
      ...srcCopies.map(ch => ch.buffer as ArrayBuffer),
      ...irCopies.map(ch => ch.buffer as ArrayBuffer),
    ];

    const req: ConvolveRequest = {
      type: 'convolve',
      sourceChannels: srcCopies,
      irChannels: irCopies,
      routingMode: routing.mode,
      monoSumLaw: routing.monoSumLaw,
      requestId,
    };

    w.postMessage(req, transferables);
  });
}

/** Terminate the worker (call on app unmount) */
export function terminateWorker(): void {
  worker?.terminate();
  worker = null;
}
