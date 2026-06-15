/**
 * Partitioned overlap-add FFT convolution
 *
 * Implements the overlap-add method with FFT blocks to avoid the O(N*M)
 * direct convolution cost. This is the correct approach for long IRs
 * and long programme material.
 *
 * Output length: N_x + N_h - 1
 * (The full IR tail is always preserved unless truncation is applied upstream.)
 *
 * Processing is Float32 throughout for browser efficiency.
 *
 * The FFT uses the Cooley-Tukey radix-2 algorithm implemented here
 * without external dependencies. For production use, a WASM FFT library
 * (e.g. FFTW via Emscripten) would provide faster transforms.
 *
 * Progress updates are emitted via the onProgress callback.
 */

// ─── Radix-2 Cooley-Tukey FFT ────────────────────────────────────────────────

/** In-place FFT on interleaved [re0, im0, re1, im1, ...] */
function fft(data: Float64Array, inverse: boolean): void {
  const n = data.length / 2;
  if (n <= 1) return;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      // swap complex pairs
      let tmp = data[2 * i];     data[2 * i]     = data[2 * j];     data[2 * j]     = tmp;
      tmp     = data[2 * i + 1]; data[2 * i + 1] = data[2 * j + 1]; data[2 * j + 1] = tmp;
    }
  }

  const sign = inverse ? 1 : -1;

  for (let len = 2; len <= n; len <<= 1) {
    const ang = sign * 2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let uRe = 1, uIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const evenRe = data[2 * (i + k)];
        const evenIm = data[2 * (i + k) + 1];
        const oddRe  = data[2 * (i + k + len / 2)];
        const oddIm  = data[2 * (i + k + len / 2) + 1];

        const tRe = uRe * oddRe - uIm * oddIm;
        const tIm = uRe * oddIm + uIm * oddRe;

        data[2 * (i + k)]           = evenRe + tRe;
        data[2 * (i + k) + 1]       = evenIm + tIm;
        data[2 * (i + k + len / 2)] = evenRe - tRe;
        data[2 * (i + k + len / 2) + 1] = evenIm - tIm;

        const newURe = uRe * wRe - uIm * wIm;
        const newUIm = uRe * wIm + uIm * wRe;
        uRe = newURe;
        uIm = newUIm;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < data.length; i++) data[i] /= n;
  }
}

/** Next power of two >= n */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Single-channel overlap-add convolution.
 * Returns Float32Array of length sourceLen + irLen - 1.
 */
export function convolveChannel(
  source: Float32Array,
  ir: Float32Array,
  onProgress?: (fraction: number) => void
): Float32Array {
  const Nx = source.length;
  const Nh = ir.length;
  const outputLen = Nx + Nh - 1;

  if (Nx === 0 || Nh === 0) return new Float32Array(outputLen);

  // Block size L: choose a power-of-two block size for the source partition.
  // The FFT size M must be >= L + Nh - 1, rounded to next power of two.
  const L = Math.min(4096, nextPow2(Nh)); // source block size
  const M = nextPow2(L + Nh - 1);         // FFT size

  const output = new Float32Array(outputLen);

  // Pre-compute IR spectrum
  const irPadded = new Float64Array(M * 2); // interleaved complex
  for (let i = 0; i < Nh; i++) irPadded[2 * i] = ir[i];
  fft(irPadded, false);

  const numBlocks = Math.ceil(Nx / L);

  for (let block = 0; block < numBlocks; block++) {
    const start = block * L;
    const end   = Math.min(start + L, Nx);

    // Fill source block (zero-padded to M)
    const xBlock = new Float64Array(M * 2);
    for (let i = start; i < end; i++) xBlock[2 * (i - start)] = source[i];
    fft(xBlock, false);

    // Complex multiply
    const yBlock = new Float64Array(M * 2);
    for (let k = 0; k < M; k++) {
      const aRe = xBlock[2 * k],     aIm = xBlock[2 * k + 1];
      const bRe = irPadded[2 * k],   bIm = irPadded[2 * k + 1];
      yBlock[2 * k]     = aRe * bRe - aIm * bIm;
      yBlock[2 * k + 1] = aRe * bIm + aIm * bRe;
    }
    fft(yBlock, true); // IFFT

    // Overlap-add: add the M real outputs to the output array starting at 'start'.
    // The first L samples are the "new" output; samples L..M-1 are the tail that
    // overlaps with the next block's output — the += on the output array handles this.
    for (let i = 0; i < M; i++) {
      const outIdx = start + i;
      if (outIdx < outputLen) {
        output[outIdx] += yBlock[2 * i];
      }
    }

    if (onProgress) onProgress((block + 1) / numBlocks);
  }

  return output;
}

/**
 * Validate that a convolution with a unit impulse returns the source unchanged.
 * Used in automated testing.
 */
export function validateUnitImpulse(length: number): boolean {
  const source = new Float32Array(length);
  for (let i = 0; i < length; i++) source[i] = Math.random() * 2 - 1;

  const ir     = new Float32Array(1);
  ir[0]        = 1.0;

  const output = convolveChannel(source, ir);

  for (let i = 0; i < length; i++) {
    if (Math.abs(output[i] - source[i]) > 1e-5) return false;
  }
  return true;
}

/**
 * Validate that a delayed impulse shifts the signal correctly.
 */
export function validateDelayedImpulse(sourceLen: number, delayFrames: number): boolean {
  const source = new Float32Array(sourceLen);
  source[0]    = 1.0;

  const ir     = new Float32Array(delayFrames + 1);
  ir[delayFrames] = 1.0;

  const output = convolveChannel(source, ir);

  return Math.abs(output[delayFrames] - 1.0) < 1e-5;
}
