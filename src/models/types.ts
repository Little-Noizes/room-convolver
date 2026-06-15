// ─── Core data models ───────────────────────────────────────────────────────
// All DSP stages communicate through these typed structures.
// No magic constants, no hidden state.

export type ChannelLayoutKind =
  | 'mono'
  | 'stereo'
  | 'binaural'
  | 'quad'
  | 'ambisonic-foa'
  | 'ambisonic-soa'
  | 'ambisonic-toa'
  | 'unknown';

export type AmbisonicOrder = 1 | 2 | 3;
export type AmbisonicNorm = 'SN3D' | 'N3D' | 'FuMa';
export type AmbisonicOrdering = 'ACN' | 'FuMa';

export interface AmbisonicFormat {
  order: AmbisonicOrder;
  normalisation: AmbisonicNorm;
  ordering: AmbisonicOrdering;
  channelCount: number; // must equal (order+1)^2
}

export interface ChannelLayout {
  kind: ChannelLayoutKind;
  channelCount: number;
  ambisonicFormat?: AmbisonicFormat;
  userConfirmed: boolean; // whether the user explicitly confirmed this
}

/** Decoded audio asset held entirely in memory as Float32 per-channel. */
export interface AudioAsset {
  id: string;
  filename: string;
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  durationSeconds: number;
  channels: Float32Array[];
  peak: number;         // absolute peak across all channels
  rms: number;          // RMS across all channels
  layout: ChannelLayout;
}

export type SourceKind = 'anechoic' | 'conventional' | 'sweep';

export interface SourceAsset extends AudioAsset {
  kind: SourceKind;
}

export type IRKind = 'ir' | 'sweep-recording';

export interface ImpulseResponseAsset extends AudioAsset {
  irKind: IRKind;
  estimatedOnsetFrame: number | null;
  estimatedNoiseFloor: number | null; // dBFS
}

// ─── Routing ────────────────────────────────────────────────────────────────

export type RoutingMode =
  | 'mono-mono'
  | 'mono-stereo'
  | 'mono-binaural'
  | 'mono-ambisonic'
  | 'stereo-direct'       // L→L, R→R
  | 'stereo-monosum-stereo'  // L+R→mono, convolve with stereo IR
  | 'stereo-true'         // four-path true stereo
  | 'stereo-monosum-binaural'
  | 'stereo-monosum-ambisonic';

export interface RoutingConfiguration {
  mode: RoutingMode;
  monoSumLaw: 'linear' | 'equal-power'; // for modes that sum to mono
}

// ─── Preprocessing ──────────────────────────────────────────────────────────

export interface PreprocessingConfiguration {
  // IR onset / trimming
  onsetMode: 'auto' | 'manual' | 'preserve';
  onsetFrame: number | null;          // null = auto-detect
  preDelayFrames: number;             // frames to retain before onset
  trimEndFrame: number | null;        // null = full IR
  fadeInFrames: number;
  fadeOutFrames: number;
  removeDC: boolean;
  highPassHz: number | null;          // null = disabled
  // Gain / normalisation
  normaliseIR: boolean;               // normalise IR before convolution
}

// ─── Gain ───────────────────────────────────────────────────────────────────

export type GainMode =
  | 'preserve'        // no post-convolution gain
  | 'peak-normalise'
  | 'loudness-normalise'
  | 'calibrated';

export interface GainConfiguration {
  mode: GainMode;
  peakTargetDbFS: number;         // e.g. -1.0
  loudnessTargetLUFS: number;     // e.g. -14.0
  dryWetMix: number;              // 0 = dry, 1 = wet
  previewLoudnessMatch: boolean;  // match levels for A/B comparison only
}

// ─── Render ─────────────────────────────────────────────────────────────────

export interface SampleRateConfig {
  sourceSampleRate: number;
  irSampleRate: number;
  targetSampleRate: number;
  strategy: 'lowest' | 'source' | 'ir' | 'custom';
}

export type ExportBitDepth = 16 | 24 | 32; // 32 = float

export interface RenderConfiguration {
  routing: RoutingConfiguration;
  preprocessing: PreprocessingConfiguration;
  gain: GainConfiguration;
  sampleRate: SampleRateConfig;
  exportBitDepth: ExportBitDepth;
  dither: boolean;
  maxOutputDurationSeconds: number | null; // null = full output
}

// ─── Results ────────────────────────────────────────────────────────────────

export type WarningSeverity = 'info' | 'warning' | 'error';

export interface ProcessingWarning {
  code: string;
  severity: WarningSeverity;
  message: string;        // human-readable
  detail?: string;        // technical explanation
}

export interface RenderResult {
  outputAsset: AudioAsset;
  warnings: ProcessingWarning[];
  report: ProcessingReport;
  wavBlob: Blob | null;   // populated after export encoding
}

export interface ProcessingReport {
  sourceFilename: string;
  sourceDurationSeconds: number;
  sourceChannelCount: number;
  sourceSampleRate: number;
  irFilename: string;
  irDurationSeconds: number;
  irChannelCount: number;
  irSampleRate: number;
  irLayout: ChannelLayout;
  resamplingApplied: boolean;
  processingSampleRate: number;
  onsetTreatment: string;
  irTrimSeconds: number | null;
  routingMode: RoutingMode;
  gainMode: GainMode;
  outputChannelCount: number;
  outputDurationSeconds: number;
  outputSampleRate: number;
  exportBitDepth: ExportBitDepth;
  renderDateISO: string;
  appVersion: string;
}

// ─── Calibration (Phase 5 stub) ──────────────────────────────────────────────

export interface CalibrationMetadata {
  sourceCalibrationLevelDbSPL: number | null;
  irReferenceLevel: number | null;
  microphoneSensitivityDbVPa: number | null;
  systemGainDb: number | null;
  playbackCalibrationDbSPL: number | null;
}

export interface ExportMetadata {
  report: ProcessingReport;
  calibration: CalibrationMetadata | null;
  warnings: ProcessingWarning[];
}
