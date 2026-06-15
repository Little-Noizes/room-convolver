/**
 * DSP unit tests
 *
 * Validates convolution, routing and encoding against known-good results.
 * Run with: npm test
 */

import { describe, it, expect } from 'vitest';
import { convolveChannel, validateUnitImpulse, validateDelayedImpulse } from '../audio/convolution/partitionedConvolution.js';
import { route } from '../audio/routing/routingEngine.js';
import { resampleChannels } from '../audio/resampling/sampleRateConverter.js';
import { encodeWav } from '../audio/encoding/wavEncoder.js';
import { decodeWav } from '../audio/decoding/wavDecoder.js';
import { measurePeakLinear, measureRMS, linearToDb, dbToLinear } from '../audio/metering/metering.js';

// ─── Convolution tests ───────────────────────────────────────────────────────

describe('Convolution', () => {
  it('unit impulse: output equals input', () => {
    expect(validateUnitImpulse(1024)).toBe(true);
  });

  it('unit impulse: small signal', () => {
    expect(validateUnitImpulse(64)).toBe(true);
  });

  it('delayed impulse: signal shifted correctly', () => {
    expect(validateDelayedImpulse(256, 100)).toBe(true);
  });

  it('output length is Nx + Nh - 1', () => {
    const Nx = 1000, Nh = 200;
    const source = new Float32Array(Nx).fill(1);
    const ir     = new Float32Array(Nh).fill(1);
    const out    = convolveChannel(source, ir);
    expect(out.length).toBe(Nx + Nh - 1);
  });

  it('gain-scaled impulse: output gain matches', () => {
    const source = new Float32Array(64);
    source[0] = 1.0;
    const ir = new Float32Array(1);
    ir[0] = 0.5;
    const out = convolveChannel(source, ir);
    expect(Math.abs(out[0] - 0.5)).toBeLessThan(1e-5);
  });

  it('silence input produces silence output', () => {
    const source = new Float32Array(256).fill(0);
    const ir     = new Float32Array(64).fill(1);
    const out    = convolveChannel(source, ir);
    const peak   = measurePeakLinear([out]);
    expect(peak).toBeLessThan(1e-9);
  });

  it('longer IR with known result', () => {
    // Convolving a 1-sample source with a known 3-sample IR
    const source = new Float32Array([1, 0, 0, 0, 0]);
    const ir     = new Float32Array([1, 2, 3]);
    const out    = convolveChannel(source, ir);
    expect(Math.abs(out[0] - 1)).toBeLessThan(1e-5);
    expect(Math.abs(out[1] - 2)).toBeLessThan(1e-5);
    expect(Math.abs(out[2] - 3)).toBeLessThan(1e-5);
  });

  it('two-sample source, two-sample IR', () => {
    // [1,2] * [3,4] = [3, 4+6, 8] = [3, 10, 8]
    const source = new Float32Array([1, 2]);
    const ir     = new Float32Array([3, 4]);
    const out    = convolveChannel(source, ir);
    expect(out.length).toBe(3);
    expect(Math.abs(out[0] - 3)).toBeLessThan(1e-4);
    expect(Math.abs(out[1] - 10)).toBeLessThan(1e-4);
    expect(Math.abs(out[2] - 8)).toBeLessThan(1e-4);
  });
});

// ─── Routing tests ───────────────────────────────────────────────────────────

describe('Routing', () => {
  it('mono-mono: output is one channel', () => {
    const src = [new Float32Array([1, 0, 0])];
    const ir  = [new Float32Array([1])];
    const result = route({ sourceChannels: src, irChannels: ir, mode: 'mono-mono', monoSumLaw: 'linear' });
    expect(result.channels.length).toBe(1);
  });

  it('mono-stereo: output is two channels', () => {
    const src = [new Float32Array([1, 0, 0])];
    const ir  = [new Float32Array([1]), new Float32Array([1])];
    const result = route({ sourceChannels: src, irChannels: ir, mode: 'mono-stereo', monoSumLaw: 'linear' });
    expect(result.channels.length).toBe(2);
  });

  it('mono-binaural: independent L/R channels', () => {
    const src  = [new Float32Array([1, 0, 0])];
    const irL  = new Float32Array([1, 0]);
    const irR  = new Float32Array([0, 1]); // R delayed by 1
    const result = route({ sourceChannels: src, irChannels: [irL, irR], mode: 'mono-binaural', monoSumLaw: 'linear' });
    expect(result.channels.length).toBe(2);
    // Left should have energy at frame 0
    expect(Math.abs(result.channels[0][0] - 1)).toBeLessThan(1e-5);
    // Right should have energy at frame 1
    expect(Math.abs(result.channels[1][1] - 1)).toBeLessThan(1e-5);
  });

  it('stereo-monosum-stereo: channels have same length', () => {
    const src = [new Float32Array([1, 0.5, 0]), new Float32Array([0.5, 1, 0])];
    const ir  = [new Float32Array([1, 0.5]), new Float32Array([0.5, 1])];
    const result = route({ sourceChannels: src, irChannels: ir, mode: 'stereo-monosum-stereo', monoSumLaw: 'linear' });
    expect(result.channels.length).toBe(2);
    expect(result.channels[0].length).toBe(result.channels[1].length);
  });

  it('stereo-direct: uses independent L and R paths', () => {
    // L source is non-zero, R source is zero — only left output should be non-zero
    const src  = [new Float32Array([1, 0]), new Float32Array([0, 0])];
    const irL  = new Float32Array([2]);
    const irR  = new Float32Array([3]);
    const result = route({ sourceChannels: src, irChannels: [irL, irR], mode: 'stereo-direct', monoSumLaw: 'linear' });
    expect(result.channels[0][0]).toBeCloseTo(2, 4); // left output = 1 * 2
    expect(result.channels[1][0]).toBeCloseTo(0, 4); // right output = 0 * 3
  });

  it('true-stereo: requires 4 IR channels', () => {
    const src = [new Float32Array([1]), new Float32Array([1])];
    const ir2 = [new Float32Array([1]), new Float32Array([1])]; // only 2 channels
    expect(() => route({ sourceChannels: src, irChannels: ir2, mode: 'stereo-true', monoSumLaw: 'linear' }))
      .toThrow(/4 IR channels/);
  });

  it('wrong channel count throws descriptive error', () => {
    const src2ch = [new Float32Array([1]), new Float32Array([1])];
    const ir1ch  = [new Float32Array([1])];
    expect(() => route({ sourceChannels: src2ch, irChannels: ir1ch, mode: 'mono-mono', monoSumLaw: 'linear' }))
      .toThrow(/mono-mono/);
  });
});

// ─── Resampling tests ────────────────────────────────────────────────────────

describe('Resampling', () => {
  it('same rate: no change', () => {
    const ch = [new Float32Array([1, 2, 3, 4])];
    const r  = resampleChannels(ch, 44100, 44100);
    expect(r.channels[0]).toEqual(ch[0]);
    expect(r.outputFrameCount).toBe(4);
  });

  it('correct output duration for downsampling', () => {
    const frames = 44100;
    const ch = [new Float32Array(frames).fill(0.5)];
    const r  = resampleChannels(ch, 44100, 22050);
    // Output length should be approximately half
    expect(r.outputFrameCount).toBeCloseTo(22050, -1);
  });

  it('correct output duration for upsampling', () => {
    const frames = 22050;
    const ch = [new Float32Array(frames).fill(0.5)];
    const r  = resampleChannels(ch, 22050, 44100);
    expect(r.outputFrameCount).toBeCloseTo(44100, -1);
  });

  it('multichannel: all channels same length', () => {
    const frames = 1000;
    const ch1 = new Float32Array(frames).fill(1);
    const ch2 = new Float32Array(frames).fill(0.5);
    const r   = resampleChannels([ch1, ch2], 48000, 44100);
    expect(r.channels[0].length).toBe(r.channels[1].length);
  });
});

// ─── WAV codec tests ─────────────────────────────────────────────────────────

describe('WAV encode/decode roundtrip', () => {
  it('32-bit float: lossless roundtrip', () => {
    const ch = [new Float32Array([0.5, -0.25, 0.1, -0.9, 0.0])];
    const buf    = encodeWav({ channels: ch, sampleRate: 44100, bitDepth: 32, dither: false });
    const decoded = decodeWav(buf);
    expect(decoded.channelCount).toBe(1);
    expect(decoded.sampleRate).toBe(44100);
    for (let i = 0; i < ch[0].length; i++) {
      expect(Math.abs(decoded.channels[0][i] - ch[0][i])).toBeLessThan(1e-6);
    }
  });

  it('24-bit PCM: low quantisation error', () => {
    const ch = [new Float32Array([0.5, -0.25, 0.1])];
    const buf     = encodeWav({ channels: ch, sampleRate: 48000, bitDepth: 24, dither: false });
    const decoded = decodeWav(buf);
    for (let i = 0; i < ch[0].length; i++) {
      expect(Math.abs(decoded.channels[0][i] - ch[0][i])).toBeLessThan(2e-7);
    }
  });

  it('16-bit PCM: quantisation within 1 LSB', () => {
    const ch = [new Float32Array([0.5, -0.5, 0.25])];
    const buf     = encodeWav({ channels: ch, sampleRate: 44100, bitDepth: 16, dither: false });
    const decoded = decodeWav(buf);
    for (let i = 0; i < ch[0].length; i++) {
      expect(Math.abs(decoded.channels[0][i] - ch[0][i])).toBeLessThan(4e-5);
    }
  });

  it('stereo: both channels preserved', () => {
    const left  = new Float32Array([0.8, 0.4]);
    const right = new Float32Array([-0.8, -0.4]);
    const buf     = encodeWav({ channels: [left, right], sampleRate: 44100, bitDepth: 32, dither: false });
    const decoded = decodeWav(buf);
    expect(decoded.channelCount).toBe(2);
    expect(Math.abs(decoded.channels[0][0] - 0.8)).toBeLessThan(1e-6);
    expect(Math.abs(decoded.channels[1][0] + 0.8)).toBeLessThan(1e-6);
  });

  it('WAV header: correct sample rate', () => {
    const ch  = [new Float32Array([0])];
    const buf = encodeWav({ channels: ch, sampleRate: 96000, bitDepth: 24, dither: false });
    const dec = decodeWav(buf);
    expect(dec.sampleRate).toBe(96000);
  });

  it('channel count preserved in header', () => {
    const chs = Array.from({ length: 4 }, () => new Float32Array([0.1, -0.1]));
    const buf = encodeWav({ channels: chs, sampleRate: 48000, bitDepth: 32, dither: false });
    const dec = decodeWav(buf);
    expect(dec.channelCount).toBe(4);
  });
});

// ─── Metering tests ──────────────────────────────────────────────────────────

describe('Metering', () => {
  it('peak of known signal', () => {
    const ch = [new Float32Array([0.1, 0.5, -0.8, 0.3])];
    expect(measurePeakLinear(ch)).toBeCloseTo(0.8, 5);
  });

  it('RMS of DC signal', () => {
    const ch = [new Float32Array(1000).fill(0.5)];
    expect(measureRMS(ch)).toBeCloseTo(0.5, 4);
  });

  it('linearToDb: 1.0 → 0 dBFS', () => {
    expect(linearToDb(1.0)).toBeCloseTo(0, 5);
  });

  it('dbToLinear: -20 dB → 0.1', () => {
    expect(dbToLinear(-20)).toBeCloseTo(0.1, 5);
  });
});
