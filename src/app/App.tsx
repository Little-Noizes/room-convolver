import { useState, useCallback } from 'react';
import type {
  SourceAsset,
  ImpulseResponseAsset,
  RoutingMode,
  RoutingConfiguration,
  PreprocessingConfiguration,
  GainConfiguration,
  SampleRateConfig,
  RenderConfiguration,
  RenderResult,
  ProcessingWarning,
  ChannelLayoutKind,
  ExportBitDepth,
} from '../models/types.js';

import { loadSourceAsset, loadIRAsset, formatDbFS } from '../audio/assetLoader.js';
import { renderConvolution } from '../audio/renderPipeline.js';
import { availableRoutingModes } from '../audio/routing/routingEngine.js';


import { UploadZone } from '../components/UploadZone.js';
import { AssetMeta } from '../components/AssetMeta.js';
import { WaveformCanvas } from '../components/WaveformCanvas.js';
import { WarningList } from '../components/WarningList.js';
import { AudioPreview } from '../components/AudioPreview.js';
import { ReportDisplay } from '../components/ReportDisplay.js';

type AppMode = 'basic' | 'advanced';

const ROUTING_LABELS: Record<RoutingMode, { name: string; desc: string }> = {
  'mono-mono':              { name: 'Mono → Mono',          desc: 'Single channel in, single channel out.' },
  'mono-stereo':            { name: 'Mono → Stereo',         desc: 'Mono source convolved independently with L and R IR channels.' },
  'mono-binaural':          { name: 'Mono → Binaural',       desc: 'Mono source convolved with left-ear and right-ear IRs. Headphones required.' },
  'mono-ambisonic':         { name: 'Mono → Ambisonic',      desc: 'Mono source convolved with each Ambisonic IR channel.' },
  'stereo-direct':          { name: 'Stereo Direct',         desc: 'L→L, R→R. Simple pairing; assumes symmetric IR capture.' },
  'stereo-monosum-stereo':  { name: 'Stereo → Mono-sum → Stereo',  desc: 'Source summed to mono, then convolved with stereo IR. Physically interpretable.' },
  'stereo-monosum-binaural':{ name: 'Stereo → Mono-sum → Binaural', desc: 'Source summed to mono, convolved with binaural IR. Recommended for binaural.' },
  'stereo-monosum-ambisonic': { name: 'Stereo → Mono-sum → Ambisonic', desc: 'Source summed to mono, convolved with each Ambisonic channel.' },
  'stereo-true':            { name: 'True Stereo (4-path)',  desc: 'Requires 4 IR channels: LL, LR, RL, RR. Applies all four transfer paths.' },
};

const LAYOUT_OPTIONS: { value: ChannelLayoutKind; label: string }[] = [
  { value: 'mono',          label: 'Mono' },
  { value: 'stereo',        label: 'Stereo' },
  { value: 'binaural',      label: 'Binaural (headphone)' },
  { value: 'ambisonic-foa', label: 'Ambisonics FOA (4ch, ACN/SN3D)' },
  { value: 'ambisonic-soa', label: 'Ambisonics 2nd order (9ch, ACN/SN3D)' },
  { value: 'ambisonic-toa', label: 'Ambisonics 3rd order (16ch, ACN/SN3D)' },
];

function defaultPreprocessing(): PreprocessingConfiguration {
  return {
    onsetMode: 'preserve',
    onsetFrame: null,
    preDelayFrames: 0,
    trimEndFrame: null,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    removeDC: false,
    highPassHz: null,
    normaliseIR: false,
  };
}

function defaultGain(): GainConfiguration {
  return {
    mode: 'peak-normalise',
    peakTargetDbFS: -1.0,
    loudnessTargetLUFS: -14.0,
    dryWetMix: 1.0,
    previewLoudnessMatch: true,
  };
}

export function App() {
  const [mode, setMode]           = useState<AppMode>('basic');

  // Assets
  const [sourceAsset, setSourceAsset]   = useState<SourceAsset | null>(null);
  const [irAsset, setIrAsset]           = useState<ImpulseResponseAsset | null>(null);
  const [loadError, setLoadError]       = useState<string | null>(null);

  // Configuration
  const [routing, setRouting]     = useState<RoutingConfiguration>({
    mode: 'mono-stereo',
    monoSumLaw: 'linear',
  });
  const [preprocessing, setPreprocessing] = useState<PreprocessingConfiguration>(defaultPreprocessing());
  const [gain, setGain]           = useState<GainConfiguration>(defaultGain());
  const [targetSR, setTargetSR]   = useState<number | null>(null);
  const [exportBitDepth, setExportBitDepth] = useState<ExportBitDepth>(24);
  const [dither, setDither]       = useState(true);

  // Render state
  const [rendering, setRendering]   = useState(false);
  const [renderProgress, setRenderProgress] = useState<{ stage: string; fraction: number } | null>(null);
  const [result, setResult]         = useState<RenderResult | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // Load source
  const handleSourceFile = useCallback(async (file: File) => {
    setLoadError(null);
    setResult(null);
    try {
      const asset = await loadSourceAsset(file, 'conventional');
      setSourceAsset(asset);
      // Auto-pick routing if possible
      if (irAsset) autoPickRouting(asset.channelCount, irAsset.channelCount, irAsset.layout.kind, setRouting);
    } catch (e) {
      setLoadError(`Source: ${(e as Error).message}`);
    }
  }, [irAsset]);

  // Load IR
  const handleIRFile = useCallback(async (file: File) => {
    setLoadError(null);
    setResult(null);
    try {
      const asset = await loadIRAsset(file);
      setIrAsset(asset);
      if (sourceAsset) autoPickRouting(sourceAsset.channelCount, asset.channelCount, asset.layout.kind, setRouting);
    } catch (e) {
      setLoadError(`IR: ${(e as Error).message}`);
    }
  }, [sourceAsset]);

  // Confirm IR layout
  const confirmLayout = (kind: ChannelLayoutKind) => {
    if (!irAsset) return;
    setIrAsset({ ...irAsset, layout: { ...irAsset.layout, kind, userConfirmed: true } });
    if (sourceAsset) autoPickRouting(sourceAsset.channelCount, irAsset.channelCount, kind, setRouting);
  };

  // Build available routing modes
  const availableModes = sourceAsset && irAsset
    ? availableRoutingModes(sourceAsset.channelCount, irAsset.channelCount)
    : [];

  // Collect input warnings before render
  const inputWarnings: ProcessingWarning[] = [];
  if (irAsset && !irAsset.layout.userConfirmed && irAsset.channelCount >= 2) {
    inputWarnings.push({
      code: 'CONFIRM_FORMAT',
      severity: 'warning',
      message: 'Confirm the IR channel format before rendering.',
      detail: `${irAsset.channelCount}-channel files are ambiguous (stereo, binaural, or Ambisonics). Select the correct format below.`,
    });
  }
  if (sourceAsset?.kind === 'conventional') {
    inputWarnings.push({
      code: 'COMMERCIAL_SOURCE',
      severity: 'info',
      message: 'Conventional recording loaded.',
      detail: 'This recording likely contains pre-existing reverberation, spatial processing and mastering. The convolved result is an experiential impression, not a strict acoustic reconstruction.',
    });
  }
  if (routing.mode.includes('binaural')) {
    inputWarnings.push({
      code: 'BINAURAL_NOTE',
      severity: 'info',
      message: 'Binaural output — use headphones.',
      detail: 'Loudspeaker playback will not reproduce the intended binaural ear signals.',
    });
  }
  if (sourceAsset && irAsset && sourceAsset.sampleRate !== irAsset.sampleRate) {
    inputWarnings.push({
      code: 'SAMPLE_RATE_MISMATCH',
      severity: 'warning',
      message: `Sample rate mismatch: source ${sourceAsset.sampleRate} Hz, IR ${irAsset.sampleRate} Hz.`,
      detail: `Files will be resampled to ${Math.min(sourceAsset.sampleRate, irAsset.sampleRate)} Hz to avoid implying additional high-frequency information. You can override this in Advanced mode.`,
    });
  }

  // Render
  const handleRender = async () => {
    if (!sourceAsset || !irAsset) return;
    setRendering(true);
    setRenderError(null);
    setResult(null);

    const srConfig: SampleRateConfig = {
      sourceSampleRate: sourceAsset.sampleRate,
      irSampleRate: irAsset.sampleRate,
      targetSampleRate: targetSR ?? Math.min(sourceAsset.sampleRate, irAsset.sampleRate),
      strategy: targetSR ? 'custom' : 'lowest',
    };

    const config: RenderConfiguration = {
      routing,
      preprocessing,
      gain,
      sampleRate: srConfig,
      exportBitDepth,
      dither,
      maxOutputDurationSeconds: null,
    };

    try {
      const r = await renderConvolution(sourceAsset, irAsset, config, setRenderProgress);
      setResult(r);
    } catch (e) {
      setRenderError((e as Error).message);
    } finally {
      setRendering(false);
      setRenderProgress(null);
    }
  };

  // Export
  const handleExport = () => {
    if (!result?.wavBlob) return;
    const url = URL.createObjectURL(result.wavBlob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = result.outputAsset.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const canRender = !!sourceAsset && !!irAsset && availableModes.includes(routing.mode) && !rendering;

  return (
    <div className="app">
      {/* ── Header ───────────────────────────────────────────────── */}
      <header className="site-header">
        <p className="site-header__eyebrow">Acoustic Convolution Tool — v0.1.0</p>
        <h1 className="site-header__title">Room Convolver</h1>
        <p className="site-header__subtitle">
          Browser-based acoustic convolution and spatial auralisation.
          Combine source audio with measured room impulse responses using high-quality offline processing.
        </p>
        <div className="site-header__privacy" role="note" aria-label="Privacy notice">
          <span className="privacy-dot" aria-hidden="true" />
          Audio files are processed locally in your browser. Nothing is uploaded to a server.
        </div>
      </header>

      {/* ── Mode toggle ───────────────────────────────────────────── */}
      <div className="mode-toggle" role="group" aria-label="Interface complexity">
        <button
          className={`mode-toggle__btn${mode === 'basic' ? ' active' : ''}`}
          onClick={() => setMode('basic')}
          type="button"
        >Basic</button>
        <button
          className={`mode-toggle__btn${mode === 'advanced' ? ' active' : ''}`}
          onClick={() => setMode('advanced')}
          type="button"
        >Advanced</button>
      </div>

      {/* ── Load errors ────────────────────────────────────────────── */}
      {loadError && (
        <div className="warning-item error" style={{ marginBottom: '1rem' }}>
          <span className="warning-item__icon">✕</span>
          <div>{loadError}</div>
        </div>
      )}

      {/* ── 1. Source ─────────────────────────────────────────────── */}
      <section className="panel" aria-labelledby="source-heading">
        <div className="panel__header">
          <span className="panel__number">01</span>
          <h2 className="panel__title" id="source-heading">Source material</h2>
          <span className={`panel__status ${sourceAsset ? 'ready' : 'pending'}`}>
            {sourceAsset ? '✓ loaded' : 'no file'}
          </span>
        </div>
        <div className="panel__body">
          {!sourceAsset ? (
            <>
              <p style={{ fontSize: '0.8125rem', color: 'var(--stone)', marginBottom: '0.75rem' }}>
                Upload the audio you want to place in the measured room.
                Dry or anechoic recordings give the most physically meaningful result.
              </p>
              <div className="source-type-select" role="group" aria-label="Source type">
                {/* In basic mode, source type is set after loading; shown here as context */}
              </div>
              <UploadZone
                onFile={handleSourceFile}
                hint="WAV · 16/24/32-bit PCM or float"
                label="Upload source audio file"
              />
            </>
          ) : (
            <>
              <div className="asset-loaded">
                <span className="asset-loaded__name">📄 {sourceAsset.filename}</span>
                <button
                  className="asset-loaded__clear"
                  onClick={() => { setSourceAsset(null); setResult(null); }}
                  type="button"
                  aria-label="Remove source file"
                >Remove</button>
              </div>

              <AssetMeta asset={sourceAsset} />

              {sourceAsset.channels[0] && (
                <WaveformCanvas channel={sourceAsset.channels[0]} />
              )}

              {/* Source kind selector */}
              <div style={{ marginTop: '0.875rem' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--stone)', marginBottom: '0.4rem' }}>
                  Source type
                </p>
                <div className="source-type-select" role="group" aria-label="Source kind">
                  {[
                    { kind: 'anechoic', label: 'Dry / anechoic', desc: 'Best for auralisation' },
                    { kind: 'conventional', label: 'Conventional recording', desc: 'Already contains room acoustics' },
                  ].map(({ kind, label, desc }) => (
                    <button
                      key={kind}
                      className={`source-type-btn${sourceAsset.kind === kind ? ' selected' : ''}`}
                      onClick={() => setSourceAsset({ ...sourceAsset, kind: kind as 'anechoic' | 'conventional' })}
                      type="button"
                      title={desc}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {sourceAsset.kind === 'conventional' && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--stone)', marginTop: '0.4rem', maxWidth: '60ch' }}>
                    <strong>Note:</strong> Conventional recordings contain pre-existing reverberation, stereo imaging and mastering.
                    Convolution adds the measured room response on top. The result is an experiential impression,
                    not a strict acoustic reconstruction.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── 2. Impulse Response ──────────────────────────────────────── */}
      <section className="panel" aria-labelledby="ir-heading">
        <div className="panel__header">
          <span className="panel__number">02</span>
          <h2 className="panel__title" id="ir-heading">Room impulse response</h2>
          <span className={`panel__status ${irAsset ? 'ready' : 'pending'}`}>
            {irAsset ? '✓ loaded' : 'no file'}
          </span>
        </div>
        <div className="panel__body">
          {!irAsset ? (
            <>
              <p style={{ fontSize: '0.8125rem', color: 'var(--stone)', marginBottom: '0.75rem' }}>
                Upload a measured impulse response. Accepted formats: mono, stereo, binaural, or Ambisonic WAV.
                Do not use MP3 for impulse responses — lossy coding alters the transient shape, noise floor and phase.
              </p>
              <UploadZone
                onFile={handleIRFile}
                hint="WAV · mono / stereo / binaural / Ambisonic"
                label="Upload impulse response file"
              />
            </>
          ) : (
            <>
              <div className="asset-loaded">
                <span className="asset-loaded__name">📄 {irAsset.filename}</span>
                <button
                  className="asset-loaded__clear"
                  onClick={() => { setIrAsset(null); setResult(null); }}
                  type="button"
                  aria-label="Remove IR file"
                >Remove</button>
              </div>

              <AssetMeta
                asset={irAsset}
                showOnset
                onsetFrame={irAsset.estimatedOnsetFrame}
                noiseFloorDb={irAsset.estimatedNoiseFloor}
              />

              {irAsset.channels[0] && (
                <WaveformCanvas channel={irAsset.channels[0]} color="#5A7BB5" />
              )}

              {/* Format confirmation */}
              {!irAsset.layout.userConfirmed && (
                <div className="format-confirm">
                  <p className="format-confirm__label">Confirm impulse response format</p>
                  <p className="format-confirm__desc">
                    {irAsset.channelCount}-channel files are ambiguous. Select the correct format to proceed.
                    Incorrect format will produce spatial errors.
                  </p>
                  <div className="format-select" role="group" aria-label="Impulse response format">
                    {LAYOUT_OPTIONS.map(({ value, label }) => (
                      <button
                        key={value}
                        className={`format-btn${irAsset.layout.kind === value ? ' selected' : ''}`}
                        onClick={() => confirmLayout(value)}
                        type="button"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {irAsset.layout.userConfirmed && (
                <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--green)' }}>
                    ✓ Format confirmed: {irAsset.layout.kind}
                  </span>
                  <button
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--stone)' }}
                    onClick={() => setIrAsset({ ...irAsset, layout: { ...irAsset.layout, userConfirmed: false } })}
                    type="button"
                  >change</button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ── 3. Routing ────────────────────────────────────────────────── */}
      {sourceAsset && irAsset && (
        <section className="panel" aria-labelledby="routing-heading">
          <div className="panel__header">
            <span className="panel__number">03</span>
            <h2 className="panel__title" id="routing-heading">Routing</h2>
          </div>
          <div className="panel__body">
            <p style={{ fontSize: '0.8125rem', color: 'var(--stone)', marginBottom: '1rem' }}>
              Select how source channels map to IR channels. This choice affects the physical interpretation of the result.
            </p>

            <div className="routing-grid" role="radiogroup" aria-label="Routing mode">
              {availableModes.map(m => (
                <div
                  key={m}
                  className={`routing-option${routing.mode === m ? ' selected' : ''}`}
                  onClick={() => setRouting({ ...routing, mode: m })}
                  role="radio"
                  aria-checked={routing.mode === m}
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setRouting({ ...routing, mode: m }); }}
                >
                  <span className="routing-option__mode">{ROUTING_LABELS[m]?.name ?? m}</span>
                  <span className="routing-option__desc">{ROUTING_LABELS[m]?.desc ?? ''}</span>
                </div>
              ))}
            </div>

            {availableModes.length === 0 && (
              <p style={{ color: 'var(--red)', fontSize: '0.8125rem' }}>
                No valid routing modes available for this source/IR combination.
                Check channel counts.
              </p>
            )}

            {/* Mono sum law (advanced) */}
            {mode === 'advanced' && routing.mode.includes('monosum') && (
              <div style={{ marginTop: '1rem' }}>
                <div className="control-row">
                  <label htmlFor="monosum-law">Mono sum law</label>
                  <select
                    id="monosum-law"
                    value={routing.monoSumLaw}
                    onChange={e => setRouting({ ...routing, monoSumLaw: e.target.value as 'linear' | 'equal-power' })}
                  >
                    <option value="linear">Linear (L+R)/2 — preserves mono-compatible level</option>
                    <option value="equal-power">Equal power (L+R)/√2 — preserves power of independent signals</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── 4. Processing ─────────────────────────────────────────────── */}
      {mode === 'advanced' && sourceAsset && irAsset && (
        <section className="panel" aria-labelledby="processing-heading">
          <div className="panel__header">
            <span className="panel__number">04</span>
            <h2 className="panel__title" id="processing-heading">Processing options</h2>
          </div>
          <div className="panel__body">
            {/* Sample rate */}
            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>Sample rate</h3>
            <div className="control-row">
              <label htmlFor="sr-target">Target sample rate</label>
              <select
                id="sr-target"
                value={targetSR ?? 0}
                onChange={e => {
                  const v = parseInt(e.target.value);
                  setTargetSR(v === 0 ? null : v);
                }}
              >
                <option value={0}>Lowest (recommended)</option>
                <option value={44100}>44.1 kHz</option>
                <option value={48000}>48 kHz</option>
                <option value={88200}>88.2 kHz</option>
                <option value={96000}>96 kHz</option>
              </select>
            </div>

            {/* IR onset */}
            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>IR onset</h3>
            <div className="control-row">
              <label htmlFor="onset-mode">Onset mode</label>
              <select
                id="onset-mode"
                value={preprocessing.onsetMode}
                onChange={e => setPreprocessing({ ...preprocessing, onsetMode: e.target.value as PreprocessingConfiguration['onsetMode'] })}
              >
                <option value="preserve">Preserve absolute delay</option>
                <option value="auto">Auto-detect onset</option>
                <option value="manual">Manual onset frame</option>
              </select>
            </div>
            {preprocessing.onsetMode === 'auto' && (
              <div className="control-row">
                <label htmlFor="predelay">Pre-delay to retain (ms)</label>
                <input
                  id="predelay"
                  type="number"
                  min={0}
                  max={500}
                  step={1}
                  value={Math.round(preprocessing.preDelayFrames / (irAsset.sampleRate / 1000))}
                  onChange={e => setPreprocessing({
                    ...preprocessing,
                    preDelayFrames: Math.round(parseFloat(e.target.value) * irAsset.sampleRate / 1000)
                  })}
                  style={{ width: '80px' }}
                />
                <span className="control-value">ms</span>
              </div>
            )}

            {/* IR preprocessing */}
            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>IR preprocessing</h3>
            <div className="control-row">
              <label htmlFor="remove-dc">
                <input
                  id="remove-dc"
                  type="checkbox"
                  checked={preprocessing.removeDC}
                  onChange={e => setPreprocessing({ ...preprocessing, removeDC: e.target.checked })}
                  style={{ marginRight: '0.4rem' }}
                />
                Remove DC offset
              </label>
            </div>
            <div className="control-row">
              <label htmlFor="hp-hz">High-pass filter</label>
              <select
                id="hp-hz"
                value={preprocessing.highPassHz ?? 0}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  setPreprocessing({ ...preprocessing, highPassHz: v === 0 ? null : v });
                }}
              >
                <option value={0}>Off</option>
                <option value={20}>20 Hz (subsonic removal)</option>
                <option value={40}>40 Hz</option>
                <option value={80}>80 Hz (handling noise)</option>
              </select>
            </div>

            {/* Gain */}
            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>Gain and normalisation</h3>
            <div className="control-row">
              <label htmlFor="gain-mode">Gain mode</label>
              <select
                id="gain-mode"
                value={gain.mode}
                onChange={e => setGain({ ...gain, mode: e.target.value as GainConfiguration['mode'] })}
              >
                <option value="preserve">Preserve linear gain — no normalisation</option>
                <option value="peak-normalise">Peak normalise</option>
                <option value="loudness-normalise">Loudness normalise (approx.)</option>
              </select>
            </div>
            {gain.mode === 'peak-normalise' && (
              <div className="control-row">
                <label htmlFor="peak-target">Peak target</label>
                <select
                  id="peak-target"
                  value={gain.peakTargetDbFS}
                  onChange={e => setGain({ ...gain, peakTargetDbFS: parseFloat(e.target.value) })}
                >
                  <option value={-1}>-1 dBFS</option>
                  <option value={-3}>-3 dBFS</option>
                  <option value={-6}>-6 dBFS</option>
                </select>
              </div>
            )}
            {gain.mode === 'loudness-normalise' && (
              <div className="control-row">
                <label htmlFor="lufs-target">LUFS target (approx.)</label>
                <select
                  id="lufs-target"
                  value={gain.loudnessTargetLUFS}
                  onChange={e => setGain({ ...gain, loudnessTargetLUFS: parseFloat(e.target.value) })}
                >
                  <option value={-14}>-14 LUFS (streaming)</option>
                  <option value={-18}>-18 LUFS (broadcast)</option>
                  <option value={-23}>-23 LUFS (EBU R128)</option>
                </select>
              </div>
            )}

            {/* Export */}
            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>Export</h3>
            <div className="control-row">
              <label htmlFor="bit-depth">Bit depth</label>
              <select
                id="bit-depth"
                value={exportBitDepth}
                onChange={e => setExportBitDepth(parseInt(e.target.value) as ExportBitDepth)}
              >
                <option value={16}>16-bit PCM</option>
                <option value={24}>24-bit PCM (recommended)</option>
                <option value={32}>32-bit float (lossless)</option>
              </select>
            </div>
            {exportBitDepth < 32 && (
              <div className="control-row">
                <label htmlFor="dither">
                  <input
                    id="dither"
                    type="checkbox"
                    checked={dither}
                    onChange={e => setDither(e.target.checked)}
                    style={{ marginRight: '0.4rem' }}
                  />
                  Apply TPDF dither
                </label>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Input warnings ──────────────────────────────────────────────── */}
      {inputWarnings.length > 0 && (
        <WarningList warnings={inputWarnings} />
      )}

      {/* ── 5. Render ────────────────────────────────────────────────────── */}
      {sourceAsset && irAsset && (
        <section className="panel" aria-labelledby="render-heading">
          <div className="panel__header">
            <span className="panel__number">05</span>
            <h2 className="panel__title" id="render-heading">Render</h2>
            {result && <span className="panel__status ready">✓ complete</span>}
          </div>
          <div className="panel__body">
            <p style={{ fontSize: '0.8125rem', color: 'var(--stone)', marginBottom: '1rem' }}>
              Renders the full convolution offline.
              The browser interface remains responsive during processing.
            </p>

            {renderProgress && (
              <div style={{ marginBottom: '1rem' }}>
                <p className="progress-label">{renderProgress.stage}</p>
                <div className="progress-bar">
                  <div
                    className="progress-bar__fill"
                    style={{ width: `${renderProgress.fraction * 100}%` }}
                    role="progressbar"
                    aria-valuenow={Math.round(renderProgress.fraction * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  />
                </div>
              </div>
            )}

            <button
              className="btn btn--amber btn--large"
              onClick={handleRender}
              disabled={!canRender}
              type="button"
            >
              {rendering ? <><span className="spinner" aria-hidden="true" /> Rendering…</> : 'Render convolution'}
            </button>

            {renderError && (
              <div className="warning-item error" style={{ marginTop: '1rem' }}>
                <span className="warning-item__icon">✕</span>
                <div>
                  <div>Render failed</div>
                  <div className="warning-item__detail">{renderError}</div>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── 6. Results ──────────────────────────────────────────────────── */}
      {result && (
        <>
          {/* Render warnings */}
          {result.warnings.length > 0 && (
            <WarningList warnings={result.warnings} />
          )}

          {/* Preview */}
          <section className="panel" aria-labelledby="preview-heading">
            <div className="panel__header">
              <span className="panel__number">06</span>
              <h2 className="panel__title" id="preview-heading">Preview and compare</h2>
            </div>
            <div className="panel__body">
              {result.outputAsset.channels[0] && (
                <div style={{ marginBottom: '1rem' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--stone)', marginBottom: '0.4rem' }}>
                    Output waveform — {result.outputAsset.channelCount} ch · {(result.outputAsset.sampleRate / 1000).toFixed(1)} kHz · {result.outputAsset.durationSeconds.toFixed(1)} s
                    · Peak {formatDbFS(result.outputAsset.peak)}
                  </p>
                  <WaveformCanvas channel={result.outputAsset.channels[0]} color="#5A7BB5" />
                </div>
              )}
              <AudioPreview dryAsset={sourceAsset} wetAsset={result.outputAsset} />
            </div>
          </section>

          {/* Export */}
          <section className="panel" aria-labelledby="export-heading">
            <div className="panel__header">
              <span className="panel__number">07</span>
              <h2 className="panel__title" id="export-heading">Export</h2>
            </div>
            <div className="panel__body">
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                <div>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>{result.outputAsset.filename}</p>
                  <p style={{ fontSize: '0.75rem', color: 'var(--stone)' }}>
                    {result.outputAsset.channelCount} ch · {(result.outputAsset.sampleRate / 1000).toFixed(1)} kHz ·
                    {exportBitDepth}-bit {exportBitDepth === 32 ? 'float' : 'PCM'} ·
                    {result.outputAsset.durationSeconds.toFixed(1)} s ·
                    ~{((result.outputAsset.frameCount * result.outputAsset.channelCount * exportBitDepth / 8) / 1024 / 1024).toFixed(1)} MB
                  </p>
                </div>
                <button className="btn btn--primary" onClick={handleExport} type="button">
                  ↓ Download WAV
                </button>
              </div>
            </div>
          </section>

          {/* Processing report */}
          <section className="panel" aria-labelledby="report-heading">
            <div className="panel__header">
              <span className="panel__number">08</span>
              <h2 className="panel__title" id="report-heading">Processing report</h2>
            </div>
            <div className="panel__body">
              <p style={{ fontSize: '0.8125rem', color: 'var(--stone)', marginBottom: '0.75rem' }}>
                Complete record of all processing applied. Embed or accompany output files with this report
                for reproducibility.
              </p>
              <ReportDisplay report={result.report} />
            </div>
          </section>
        </>
      )}

      {/* ── About ─────────────────────────────────────────────────────── */}
      <section style={{ marginTop: '2rem' }}>
        <details>
          <summary>About methodology and limitations</summary>
          <div style={{ fontSize: '0.8125rem', color: 'var(--stone)', lineHeight: 1.65, maxWidth: '70ch' }}>
            <p style={{ marginBottom: '0.75rem' }}>
              <strong style={{ color: 'var(--ink)' }}>Convolution method.</strong>{' '}
              Partitioned overlap-add FFT convolution, processed in Float32 throughout.
              Output length is N_source + N_IR − 1. The full reverberant tail is preserved
              unless trimming is applied.
            </p>
            <p style={{ marginBottom: '0.75rem' }}>
              <strong style={{ color: 'var(--ink)' }}>Sample-rate conversion.</strong>{' '}
              Lanczos-windowed sinc interpolation. Not equivalent to a dedicated
              hardware or WASM SRC library; suitable for most use cases.
              All channels are resampled with identical phase behaviour to preserve
              inter-channel timing.
            </p>
            <p style={{ marginBottom: '0.75rem' }}>
              <strong style={{ color: 'var(--ink)' }}>Perceived quality differences.</strong>{' '}
              Differences between acoustic software are frequently caused by IR quality,
              sample-rate conversion, truncation, onset alignment, normalisation and routing —
              not by the mathematical convolution operation itself, which is deterministic.
              This application makes all such transformations visible and configurable.
            </p>
            <p style={{ marginBottom: '0.75rem' }}>
              <strong style={{ color: 'var(--ink)' }}>Calibration.</strong>{' '}
              No output is absolutely calibrated for SPL unless the source and IR both include
              valid calibration metadata. Normalised audio is suitable for listening comparisons only.
            </p>
            <p>
              <strong style={{ color: 'var(--ink)' }}>Privacy.</strong>{' '}
              All processing is local. Files do not leave your browser.
              No analytics are collected.
            </p>
          </div>
        </details>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="site-footer">
        <span>Room Convolver v0.1.0 — Phase 1</span>
        <span>Processing is local and private</span>
        <a href="https://github.com" target="_blank" rel="noopener noreferrer">Source code</a>
        <span>WAV · PCM 16/24-bit · IEEE Float 32-bit</span>
      </footer>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function autoPickRouting(
  sourceChannels: number,
  irChannels: number,
  irKind: ChannelLayoutKind,
  setRouting: (r: RoutingConfiguration) => void
) {
  let mode: RoutingMode = 'mono-mono';

  if (sourceChannels === 1) {
    if (irChannels === 1)  mode = 'mono-mono';
    else if (irKind === 'binaural') mode = 'mono-binaural';
    else if (irChannels >= 2) mode = 'mono-stereo';
    if (irChannels === 4 || irChannels === 9 || irChannels === 16) mode = 'mono-ambisonic';
  } else {
    if (irChannels === 1)  mode = 'stereo-monosum-stereo'; // will fail gracefully
    else if (irKind === 'binaural') mode = 'stereo-monosum-binaural';
    else mode = 'stereo-monosum-stereo';
  }

  setRouting({ mode, monoSumLaw: 'linear' });
}
