/**
 * Render pipeline
 *
 * Orchestrates the full processing chain:
 *   Decode → Inspect → Resample → IR preprocessing → Routing → Convolution
 *   → Gain → Output
 *
 * Each stage is explicit and produces structured output.
 * No hidden gain changes. All transformations are recorded in the report.
 */

import type {
  SourceAsset,
  ImpulseResponseAsset,
  RenderConfiguration,
  RenderResult,
  ProcessingReport,
  ProcessingWarning,
  AudioAsset,
} from '../models/types.js';

import { resampleChannels, chooseSampleRate } from './resampling/sampleRateConverter.js';
import { convolveViaWorker } from '../workers/workerBridge.js';
import {
  measurePeakLinear,
  measureRMS,
  linearToDb,
  dbToLinear,
  detectOnset,
  hasClipping,
  countClippedSamples,
  gainChannels,
  applyFadeIn,
  applyFadeOut,
  removeDC,
  applyHighPass,
  trimChannels,
} from './metering/metering.js';
import { encodeWav } from './encoding/wavEncoder.js';

const APP_VERSION = '0.1.0';

export interface RenderProgress {
  stage: string;
  fraction: number; // 0..1
}

export async function renderConvolution(
  source: SourceAsset,
  ir: ImpulseResponseAsset,
  config: RenderConfiguration,
  onProgress?: (p: RenderProgress) => void
): Promise<RenderResult> {
  const warnings: ProcessingWarning[] = [];
  const progress = (stage: string, fraction: number) => onProgress?.({ stage, fraction });

  progress('Analysing inputs', 0);

  // ── Memory estimation ─────────────────────────────────────────────────────
  const sourceBytes = source.channels.reduce((s, ch) => s + ch.byteLength, 0);
  const irBytes     = ir.channels.reduce((s, ch) => s + ch.byteLength, 0);
  // Working memory: source + IR + output + FFT buffers (~4× source as rough estimate)
  const estimatedMB = (sourceBytes + irBytes) * 8 / (1024 * 1024);
  if (estimatedMB > 512) {
    warnings.push({
      code: 'MEMORY_WARNING',
      severity: 'warning',
      message: `Estimated working memory: ~${Math.round(estimatedMB)} MB.`,
      detail: 'Large files may exhaust browser memory. Consider using "Render excerpt" or reducing file length.',
    });
  }

  // ── Warnings based on input types ──────────────────────────────────────────
  if (source.kind === 'conventional') {
    warnings.push({
      code: 'COMMERCIAL_SOURCE',
      severity: 'info',
      message: 'Conventional recording detected.',
      detail:
        'This recording may already contain reverberation, stereo imaging and mastering. ' +
        'Convolution will add the measured room response to those existing characteristics. ' +
        'The result is an experiential impression, not a strict reconstruction of the original performance in the measured room.',
    });
  }

  if (ir.layout.kind === 'mono') {
    warnings.push({
      code: 'MONO_IR',
      severity: 'info',
      message: 'Mono impulse response.',
      detail: 'A mono impulse response represents one transfer path and cannot reproduce the full spatial impression of a room.',
    });
  }

  if (ir.layout.kind === 'unknown' && !ir.layout.userConfirmed) {
    warnings.push({
      code: 'AMBIGUOUS_IR_FORMAT',
      severity: 'warning',
      message: 'Impulse response format not confirmed.',
      detail:
        'The channel count of this IR is ambiguous. Confirm the intended spatial format before processing.',
    });
  }

  if (ir.layout.kind === 'binaural') {
    warnings.push({
      code: 'BINAURAL_HEADPHONES',
      severity: 'info',
      message: 'Binaural output.',
      detail: 'Binaural reproduction is intended for headphones. Loudspeaker playback will not reproduce the intended ear signals.',
    });
  }

  // ── Sample rate handling ───────────────────────────────────────────────────
  progress('Resampling', 0.05);

  const { sampleRate: srConfig } = config;
  const targetSR = chooseSampleRate(
    source.sampleRate,
    ir.sampleRate,
    srConfig.strategy,
    srConfig.targetSampleRate
  );

  let sourceChannels: Float32Array[] = source.channels;
  let irChannels: Float32Array[]     = ir.channels;
  let resamplingApplied              = false;

  if (source.sampleRate !== targetSR) {
    const r = resampleChannels(source.channels, source.sampleRate, targetSR);
    sourceChannels   = r.channels;
    resamplingApplied = true;
    if (srConfig.strategy === 'lowest' || source.sampleRate > ir.sampleRate) {
      warnings.push({
        code: 'SOURCE_RESAMPLED',
        severity: 'info',
        message: `Source resampled from ${source.sampleRate} Hz to ${targetSR} Hz.`,
        detail: srConfig.strategy === 'lowest'
          ? 'The files use different sample rates. They will be converted to the lower sample rate to avoid implying additional high-frequency information.'
          : `Source resampled to target rate ${targetSR} Hz.`,
      });
    }
  }

  if (ir.sampleRate !== targetSR) {
    const r = resampleChannels(ir.channels, ir.sampleRate, targetSR);
    irChannels       = r.channels;
    resamplingApplied = true;
    warnings.push({
      code: 'IR_RESAMPLED',
      severity: 'info',
      message: `IR resampled from ${ir.sampleRate} Hz to ${targetSR} Hz.`,
    });
  }

  // ── IR preprocessing ───────────────────────────────────────────────────────
  progress('Preprocessing IR', 0.1);

  const pre = config.preprocessing;
  let onsetFrame  = 0;
  let irTrimSec: number | null = null;
  let onsetTreatment = 'Absolute delay preserved';

  if (pre.onsetMode === 'auto') {
    // Detect on first channel; all channels trimmed identically
    onsetFrame     = detectOnset(irChannels[0]);
    onsetTreatment = `Onset auto-detected at frame ${onsetFrame} (${(onsetFrame / targetSR * 1000).toFixed(1)} ms)`;
  } else if (pre.onsetMode === 'manual' && pre.onsetFrame !== null) {
    onsetFrame     = pre.onsetFrame;
    onsetTreatment = `Onset manually set to frame ${onsetFrame}`;
  }

  // Pre-delay
  const trimStart = Math.max(0, onsetFrame - pre.preDelayFrames);
  let trimEnd     = irChannels[0].length;

  if (pre.trimEndFrame !== null) {
    trimEnd    = pre.trimEndFrame;
    irTrimSec  = (trimEnd - trimStart) / targetSR;
  }

  if (trimStart > 0 || pre.trimEndFrame !== null) {
    irChannels = trimChannels(irChannels, trimStart, trimEnd);
    if (!irTrimSec) irTrimSec = irChannels[0].length / targetSR;
  }

  // DC removal — applied to all channels identically
  if (pre.removeDC) {
    for (const ch of irChannels) removeDC(ch);
  }

  // High-pass filter
  if (pre.highPassHz !== null) {
    for (const ch of irChannels) applyHighPass(ch, pre.highPassHz, targetSR);
  }

  // Fades
  if (pre.fadeInFrames > 0) applyFadeIn(irChannels, pre.fadeInFrames);
  if (pre.fadeOutFrames > 0) applyFadeOut(irChannels, pre.fadeOutFrames);

  // ── Routing and convolution ────────────────────────────────────────────────
  progress('Convolving', 0.15);

  const rawOutput = await convolveViaWorker({
    sourceChannels,
    irChannels,
    routing: config.routing,
    onProgress: (stage, f) => progress(stage, 0.15 + f * 0.65),
  });

  progress('Applying gain', 0.82);

  // ── Gain handling ──────────────────────────────────────────────────────────
  const gainConfig = config.gain;
  let outputChannels = rawOutput;

  const rawPeak = measurePeakLinear(outputChannels);

  switch (gainConfig.mode) {
    case 'preserve': {

      if (rawPeak >= 1.0) {
        warnings.push({
          code: 'OUTPUT_CLIPPING',
          severity: 'warning',
          message: `Output peak is ${linearToDb(rawPeak).toFixed(1)} dBFS. Clipping will occur.`,
          detail: 'Switch to peak-normalise mode or apply gain reduction before export.',
        });
      }
      break;
    }
    case 'peak-normalise': {
      const targetLinear = dbToLinear(gainConfig.peakTargetDbFS);
      const gain         = rawPeak > 0 ? targetLinear / rawPeak : 1;
      outputChannels     = gainChannels(outputChannels, gain);

      break;
    }
    case 'loudness-normalise': {
      // Approximate integrated loudness via RMS (true ITU-R BS.1770 requires a filter chain)
      const rmsLinear    = measureRMS(outputChannels);
      const targetLinear = dbToLinear(gainConfig.loudnessTargetLUFS);
      const gain         = rmsLinear > 0 ? targetLinear / rmsLinear : 1;
      outputChannels     = gainChannels(outputChannels, gain);

        `Approximate loudness-normalised to ${gainConfig.loudnessTargetLUFS} LUFS target ` +
        `(RMS-based, non-calibrated). Gain ${linearToDb(gain).toFixed(1)} dB.`;
      warnings.push({
        code: 'LOUDNESS_APPROX',
        severity: 'info',
        message: 'Loudness normalisation is approximate.',
        detail: 'True ITU-R BS.1770 integrated loudness requires a K-weighting filter chain. RMS-based normalisation is used here for convenience.',
      });
      break;
    }
    case 'calibrated': {

      break;
    }
  }

  // Check final peak
  const finalPeak = measurePeakLinear(outputChannels);
  if (hasClipping(outputChannels)) {
    const count = countClippedSamples(outputChannels);
    warnings.push({
      code: 'FINAL_CLIPPING',
      severity: 'error',
      message: `Output contains ${count} clipped sample(s). Export will be distorted.`,
      detail: 'Apply gain reduction before export or use peak-normalise mode.',
    });
  }

  // ── Encode WAV ─────────────────────────────────────────────────────────────
  progress('Encoding WAV', 0.90);

  const wavBuffer = encodeWav({
    channels: outputChannels,
    sampleRate: targetSR,
    bitDepth: config.exportBitDepth,
    dither: config.dither && config.exportBitDepth < 32,
  });
  const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });

  // ── Build result asset ─────────────────────────────────────────────────────
  const outputAsset: AudioAsset = {
    id: `render-${Date.now()}`,
    filename: `${source.filename.replace(/\.[^.]+$/, '')}_room-convolved.wav`,
    sampleRate: targetSR,
    channelCount: outputChannels.length,
    frameCount: outputChannels[0].length,
    durationSeconds: outputChannels[0].length / targetSR,
    channels: outputChannels,
    peak: finalPeak,
    rms: measureRMS(outputChannels),
    layout: {
      kind: inferOutputLayout(config.routing.mode),
      channelCount: outputChannels.length,
      userConfirmed: false,
    },
  };

  // ── Processing report ──────────────────────────────────────────────────────
  const report: ProcessingReport = {
    sourceFilename: source.filename,
    sourceDurationSeconds: source.durationSeconds,
    sourceChannelCount: source.channelCount,
    sourceSampleRate: source.sampleRate,
    irFilename: ir.filename,
    irDurationSeconds: ir.durationSeconds,
    irChannelCount: ir.channelCount,
    irSampleRate: ir.sampleRate,
    irLayout: ir.layout,
    resamplingApplied,
    processingSampleRate: targetSR,
    onsetTreatment,
    irTrimSeconds: irTrimSec,
    routingMode: config.routing.mode,
    gainMode: config.gain.mode,
    outputChannelCount: outputChannels.length,
    outputDurationSeconds: outputAsset.durationSeconds,
    outputSampleRate: targetSR,
    exportBitDepth: config.exportBitDepth,
    renderDateISO: new Date().toISOString(),
    appVersion: APP_VERSION,
  };

  progress('Complete', 1.0);

  return {
    outputAsset,
    warnings,
    report,
    wavBlob,
  };
}

function inferOutputLayout(mode: RenderConfiguration['routing']['mode']): AudioAsset['layout']['kind'] {
  switch (mode) {
    case 'mono-mono':              return 'mono';
    case 'mono-binaural':
    case 'stereo-monosum-binaural': return 'binaural';
    case 'mono-ambisonic':
    case 'stereo-monosum-ambisonic': return 'ambisonic-foa'; // Will be refined when Ambisonics fully implemented
    default:                       return 'stereo';
  }
}
