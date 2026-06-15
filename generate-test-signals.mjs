#!/usr/bin/env node
/**
 * Generate synthetic test signals for the Room Convolver test suite.
 * 
 * Produces:
 *   test-data/dry-impulse.wav         — single sample impulse
 *   test-data/dry-sine-440.wav        — 1s 440 Hz sine tone (mono, 48 kHz)
 *   test-data/dry-whitenoise.wav      — 1s white noise (mono, 48 kHz)
 *   test-data/ir-mono-room.wav        — synthetic mono room IR (48 kHz)
 *   test-data/ir-stereo-room.wav      — synthetic stereo room IR (48 kHz)
 *   test-data/ir-unit-impulse.wav     — unit impulse (for validation)
 *   test-data/ir-delayed-impulse.wav  — 10 ms delayed impulse (for validation)
 *   test-data/ir-decay-mono.wav       — exponential decay (simulates RT60)
 * 
 * These are openly licensed synthetic signals. They do not represent real venues.
 * Run with: node generate-test-signals.mjs
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'test-data');

mkdirSync(OUTPUT_DIR, { recursive: true });

const SR = 48000;

// ── WAV encoder (minimal, for test generation only) ──────────────────────────

function writeWav(filename, channels, sampleRate) {
  const channelCount  = channels.length;
  const frameCount    = channels[0].length;
  const bytesPerSample = 4; // 32-bit float
  const dataLen       = frameCount * channelCount * bytesPerSample;
  const buf           = Buffer.alloc(44 + dataLen);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);           // chunk size
  buf.writeUInt16LE(3, 20);            // IEEE float
  buf.writeUInt16LE(channelCount, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28); // byteRate
  buf.writeUInt16LE(channelCount * bytesPerSample, 32);              // blockAlign
  buf.writeUInt16LE(32, 34);           // bit depth
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);

  let pos = 44;
  for (let f = 0; f < frameCount; f++) {
    for (let c = 0; c < channelCount; c++) {
      buf.writeFloatLE(channels[c][f], pos);
      pos += 4;
    }
  }

  const path = join(OUTPUT_DIR, filename);
  writeFileSync(path, buf);
  console.log(`  wrote ${filename} (${channelCount}ch, ${sampleRate} Hz, ${frameCount} frames)`);
}

// ── Signal generators ─────────────────────────────────────────────────────────

function unitImpulse(length) {
  const ch = new Float32Array(length);
  ch[0] = 1.0;
  return ch;
}

function delayedImpulse(length, delaySamples) {
  const ch = new Float32Array(length);
  ch[delaySamples] = 1.0;
  return ch;
}

function sineWave(durationSec, freqHz, amplitude = 0.5) {
  const frames = Math.round(durationSec * SR);
  const ch     = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    ch[i] = amplitude * Math.sin(2 * Math.PI * freqHz * i / SR);
  }
  // Fade 5ms at start and end
  const fade = Math.round(0.005 * SR);
  for (let i = 0; i < fade; i++) {
    ch[i] *= i / fade;
    ch[frames - 1 - i] *= i / fade;
  }
  return ch;
}

function whiteNoise(durationSec, amplitude = 0.3) {
  const frames = Math.round(durationSec * SR);
  const ch     = new Float32Array(frames);
  // Seeded-ish random for reproducibility
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF;
    return ((seed >>> 0) / 0xFFFFFFFF) * 2 - 1;
  };
  for (let i = 0; i < frames; i++) ch[i] = rand() * amplitude;
  const fade = Math.round(0.01 * SR);
  for (let i = 0; i < fade; i++) {
    ch[i] *= i / fade;
    ch[frames - 1 - i] *= i / fade;
  }
  return ch;
}

/**
 * Synthetic room IR: exponential decay with sparse early reflections.
 * NOT a real room measurement — clearly labelled synthetic.
 */
function syntheticRoomIR(rt60Sec = 0.8, predelayMs = 5, length = null) {
  const frames    = length ?? Math.round((rt60Sec * 1.5 + predelayMs / 1000) * SR);
  const ch        = new Float32Array(frames);
  const onset     = Math.round(predelayMs * SR / 1000);

  // Direct sound
  ch[onset] = 0.9;

  // Early reflections (first 80ms)
  const erEnd = onset + Math.round(0.08 * SR);
  let seed = 98765;
  const rand = () => {
    seed = (seed * 22695477 + 1) & 0xFFFFFFFF;
    return ((seed >>> 0) / 0xFFFFFFFF) * 2 - 1;
  };
  for (let i = onset + 1; i < Math.min(erEnd, frames); i++) {
    // Sparse early reflections decaying from onset
    const t       = (i - onset) / SR;
    const decay   = Math.exp(-3 * t / rt60Sec);
    ch[i]        += rand() * decay * 0.15;
  }

  // Diffuse tail: exponential decay with random noise
  const log001 = Math.log(0.001);
  for (let i = onset; i < frames; i++) {
    const t     = (i - onset) / SR;
    const decay = Math.exp(log001 * t / rt60Sec);
    ch[i]      += rand() * decay * 0.4;
  }

  // Normalise to peak ~0.9
  let peak = 0;
  for (let i = 0; i < frames; i++) if (Math.abs(ch[i]) > peak) peak = Math.abs(ch[i]);
  if (peak > 0) for (let i = 0; i < frames; i++) ch[i] = ch[i] / peak * 0.9;

  return ch;
}

// ── Generate files ─────────────────────────────────────────────────────────

console.log('Generating synthetic test signals...');
console.log(`Output: ${OUTPUT_DIR}\n`);
console.log('These are synthetic signals. They do not represent real venues.\n');

// Source signals
writeWav('dry-impulse.wav',      [unitImpulse(SR)],              SR);
writeWav('dry-sine-440hz.wav',   [sineWave(1.0, 440)],           SR);
writeWav('dry-sine-1khz.wav',    [sineWave(1.0, 1000)],          SR);
writeWav('dry-whitenoise.wav',   [whiteNoise(1.0)],              SR);
writeWav('dry-stereo-sine.wav',  [sineWave(1.0, 440, 0.5),
                                   sineWave(1.0, 880, 0.5)],     SR);

// IRs for validation
writeWav('ir-unit-impulse.wav',    [unitImpulse(100)],                    SR);
writeWav('ir-delayed-10ms.wav',    [delayedImpulse(SR, Math.round(0.01 * SR))], SR);

// Synthetic room IRs
const irMono   = syntheticRoomIR(0.8, 5);
const irMono2  = syntheticRoomIR(0.75, 5); // slightly different for stereo R
writeWav('ir-mono-room.wav',    [irMono],          SR);
writeWav('ir-stereo-room.wav',  [irMono, irMono2], SR);

// Exponential decay only (no early reflections — for RT60 estimation tests)
{
  const frames = Math.round(1.0 * SR);
  const decay  = new Float32Array(frames);
  for (let i = 0; i < frames; i++) decay[i] = Math.exp(-6.908 * i / frames); // RT60 = 1s
  writeWav('ir-pure-decay-1s.wav', [decay], SR);
}

console.log('\nDone. These files are synthetic — suitable for testing and demonstration only.');
console.log('Do not use them as room measurements or imply they represent real acoustics.');
