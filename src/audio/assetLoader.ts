/**
 * Asset loader
 *
 * Decodes an uploaded File into an AudioAsset, SourceAsset or ImpulseResponseAsset.
 * Validates the file and infers initial metadata.
 * Does not upload the file anywhere — purely client-side.
 */

import { decodeWav } from './decoding/wavDecoder.js';
import {
  measurePeakLinear,
  measureRMS,
  detectOnset,
  estimateNoiseFloor,
  linearToDb,
} from './metering/metering.js';
import type {
  AudioAsset,
  SourceAsset,
  ImpulseResponseAsset,
  ChannelLayout,
  ChannelLayoutKind,
  SourceKind,
} from '../models/types.js';

let idCounter = 0;
const nextId = () => `asset-${++idCounter}`;

/** Maximum decoded duration we'll accept in Phase 1 (seconds) */
const MAX_DURATION_SECONDS = 600; // 10 minutes

/** Maximum file size to attempt decoding (bytes) */
const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB

export async function loadSourceAsset(file: File, kind: SourceKind): Promise<SourceAsset> {
  const base = await loadAudioAsset(file);
  return { ...base, kind };
}

export async function loadIRAsset(file: File): Promise<ImpulseResponseAsset> {
  const base = await loadAudioAsset(file);

  // Onset detection on channel 0
  const onsetFrame = detectOnset(base.channels[0]);

  // Noise floor from tail of channel 0
  const noiseFloor = estimateNoiseFloor(base.channels[0]);

  return {
    ...base,
    irKind: 'ir',
    estimatedOnsetFrame: onsetFrame,
    estimatedNoiseFloor: noiseFloor,
  };
}

async function loadAudioAsset(file: File): Promise<AudioAsset> {
  // Sanitise filename for display only — never execute it
  const filename = sanitiseFilename(file.name);

  // File size guard
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `File "${filename}" is ${(file.size / 1024 / 1024).toFixed(0)} MB. ` +
      `The current limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`
    );
  }

  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!['wav', 'wave'].includes(extension)) {
    throw new Error(
      `File "${filename}" has extension ".${extension}". ` +
      `Only WAV files are accepted in this version. ` +
      `MP3, AAC and other compressed formats are not suitable for impulse responses ` +
      `and are not accepted.`
    );
  }

  const buffer = await readFileAsArrayBuffer(file);

  // WAV decode — detailed error messages from wavDecoder
  const decoded = decodeWav(buffer);

  const durationSeconds = decoded.frameCount / decoded.sampleRate;

  if (durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error(
      `File "${filename}" is ${durationSeconds.toFixed(1)} seconds long. ` +
      `The current limit is ${MAX_DURATION_SECONDS} seconds. ` +
      `Consider trimming the file before uploading.`
    );
  }

  // Validate no channel has a different length (should not happen in valid WAV)
  for (let c = 0; c < decoded.channels.length; c++) {
    if (decoded.channels[c].length !== decoded.frameCount) {
      throw new Error(
        `Channel ${c} has ${decoded.channels[c].length} frames but expected ${decoded.frameCount}. ` +
        `The file may be corrupt.`
      );
    }
  }

  const peak = measurePeakLinear(decoded.channels);
  const rms  = measureRMS(decoded.channels);

  const layout = inferInitialLayout(decoded.channelCount);

  return {
    id: nextId(),
    filename,
    sampleRate: decoded.sampleRate,
    channelCount: decoded.channelCount,
    frameCount: decoded.frameCount,
    durationSeconds,
    channels: decoded.channels,
    peak,
    rms,
    layout,
  };
}

/** Infer a plausible initial channel layout from channel count.
 *  This is NOT confirmed — the user must verify ambiguous formats. */
function inferInitialLayout(channelCount: number): ChannelLayout {
  let kind: ChannelLayoutKind;
  let userConfirmed = false;

  switch (channelCount) {
    case 1:
      kind = 'mono';
      userConfirmed = true; // mono is unambiguous
      break;
    case 2:
      kind = 'stereo'; // Could be binaural — user must confirm
      userConfirmed = false;
      break;
    case 4:
      kind = 'ambisonic-foa'; // Could be quad — user must confirm
      userConfirmed = false;
      break;
    case 9:
      kind = 'ambisonic-soa';
      userConfirmed = false;
      break;
    case 16:
      kind = 'ambisonic-toa';
      userConfirmed = false;
      break;
    default:
      kind = 'unknown';
      userConfirmed = false;
  }

  return { kind, channelCount, userConfirmed };
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

/** Strip potentially dangerous characters from filenames before display */
function sanitiseFilename(name: string): string {
  // Only keep safe characters; replace anything else with _
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 255);
}

/** Format bytes to human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Format duration to mm:ss.s */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatDbFS(linear: number): string {
  const db = linearToDb(linear);
  return isFinite(db) ? `${db.toFixed(1)} dBFS` : '−∞ dBFS';
}
