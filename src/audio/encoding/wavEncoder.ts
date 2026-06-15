/**
 * WAV encoder
 *
 * Produces PCM 16-bit, 24-bit, or IEEE 32-bit float WAV from Float32 channels.
 *
 * For 24-bit output: applies TPDF dither when dither=true.
 * For 16-bit output: applies TPDF dither when dither=true.
 * For 32-bit float: dither has no effect (full precision preserved).
 *
 * Does NOT apply a brickwall limiter. Clipping must be handled upstream.
 */

import type { ExportBitDepth } from '../../models/types.js';

export interface WavEncodeOptions {
  channels: Float32Array[];
  sampleRate: number;
  bitDepth: ExportBitDepth;
  dither: boolean;
}

export function encodeWav(opts: WavEncodeOptions): ArrayBuffer {
  const { channels, sampleRate, bitDepth, dither } = opts;
  const channelCount = channels.length;
  const frameCount   = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const useFloat = bitDepth === 32;
  const dataByteLen    = frameCount * channelCount * bytesPerSample;
  const headerByteLen  = 44;
  const totalByteLen   = headerByteLen + dataByteLen;

  const buffer  = new ArrayBuffer(totalByteLen);
  const view    = new DataView(buffer);
  let pos       = 0;

  const writeU32BE = (v: number) => { view.setUint32(pos, v, false); pos += 4; }
  const writeU32LE = (v: number) => { view.setUint32(pos, v, true);  pos += 4; }
  const writeU16LE = (v: number) => { view.setUint16(pos, v, true);  pos += 2; }

  const audioFormat = useFloat ? 3 : 1; // 3=IEEE_FLOAT, 1=PCM
  const blockAlign  = channelCount * bytesPerSample;
  const byteRate    = sampleRate * blockAlign;

  // RIFF header
  writeU32BE(0x52494646);           // 'RIFF'
  writeU32LE(totalByteLen - 8);     // file size minus RIFF chunk header
  writeU32BE(0x57415645);           // 'WAVE'

  // fmt  chunk
  writeU32BE(0x666D7420);           // 'fmt '
  writeU32LE(16);                   // fmt chunk size (no extension)
  writeU16LE(audioFormat);
  writeU16LE(channelCount);
  writeU32LE(sampleRate);
  writeU32LE(byteRate);
  writeU16LE(blockAlign);
  writeU16LE(bitDepth);

  // data chunk
  writeU32BE(0x64617461);           // 'data'
  writeU32LE(dataByteLen);

  // Encode interleaved samples
  for (let f = 0; f < frameCount; f++) {
    for (let c = 0; c < channelCount; c++) {
      let s = channels[c][f];

      if (useFloat) {
        view.setFloat32(pos, s, true);
        pos += 4;
      } else if (bitDepth === 16) {
        if (dither) s += tpdfDither(1.0 / 32768.0);
        const v = Math.max(-32768, Math.min(32767, Math.round(s * 32768.0)));
        view.setInt16(pos, v, true);
        pos += 2;
      } else if (bitDepth === 24) {
        if (dither) s += tpdfDither(1.0 / 8388608.0);
        const v = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388608.0)));
        // Write 3 bytes little-endian
        view.setUint8(pos,     v & 0xFF);
        view.setUint8(pos + 1, (v >> 8) & 0xFF);
        view.setUint8(pos + 2, (v >> 16) & 0xFF);
        pos += 3;
      }
    }
  }

  return buffer;
}

/** Triangular probability density function dither — one LSB peak */
function tpdfDither(lsb: number): number {
  return lsb * (Math.random() - Math.random());
}

/** 32-bit is always IEEE float format in this encoder */

/** Scan channels for peak absolute value. Returns 0 for empty input. */
export function measurePeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Scan channels for RMS. Returns 0 for empty input. */
export function measureRMS(channels: Float32Array[]): number {
  let sumSq = 0;
  let count = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
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
