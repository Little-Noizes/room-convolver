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
import { MultiIRPreview } from '../components/MultiIRPreview.js';
import { ReportDisplay } from '../components/ReportDisplay.js';

type AppMode = 'basic' | 'advanced';

// The four comparison slots. A is always dry.
export type SlotId = 'B' | 'C' | 'D';
const IR_SLOTS: SlotId[] = ['B', 'C', 'D'];

const DEFAULT_LABELS: Record<SlotId, string> = {
  B: 'Option B',
  C: 'Option C',
  D: 'Option D',
};

export interface IRSlot {
  id: SlotId;
  label: string;
  ir: ImpulseResponseAsset | null;
  result: RenderResult | null;
  rendering: boolean;
  error: string | null;
  progress: { stage: string; fraction: number } | null;
}

const ROUTING_LABELS: Record<RoutingMode, { name: string; desc: string }> = {
  'mono-mono':               { name: 'Mono → Mono',                    desc: 'Single channel in, single channel out.' },
  'mono-stereo':             { name: 'Mono → Stereo',                   desc: 'Mono source convolved independently with L and R IR channels.' },
  'mono-binaural':           { name: 'Mono → Binaural',                 desc: 'Mono source convolved with left-ear and right-ear IRs. Headphones required.' },
  'mono-ambisonic':          { name: 'Mono → Ambisonic',                desc: 'Mono source convolved with each Ambisonic IR channel.' },
  'stereo-direct':           { name: 'Stereo Direct',                   desc: 'L→L, R→R. Simple pairing; assumes symmetric IR capture.' },
  'stereo-monosum-stereo':   { name: 'Stereo → Mono-sum → Stereo',      desc: 'Source summed to mono, then convolved with stereo IR. Physically interpretable.' },
  'stereo-monosum-binaural': { name: 'Stereo → Mono-sum → Binaural',    desc: 'Source summed to mono, convolved with binaural IR. Recommended for binaural.' },
  'stereo-monosum-ambisonic':{ name: 'Stereo → Mono-sum → Ambisonic',   desc: 'Source summed to mono, convolved with each Ambisonic channel.' },
  'stereo-true':             { name: 'True Stereo (4-path)',             desc: 'Requires 4 IR channels: LL, LR, RL, RR. Applies all four transfer paths.' },
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
    onsetMode: 'auto',
    onsetFrame: null,
    preDelayFrames: 240, // 5 ms at 48 kHz
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

function makeSlot(id: SlotId): IRSlot {
  return { id, label: DEFAULT_LABELS[id], ir: null, result: null, rendering: false, error: null, progress: null };
}

export function App() {
  const [mode, setMode] = useState<AppMode>('basic');

  // Source
  const [sourceAsset, setSourceAsset] = useState<SourceAsset | null>(null);
  const [loadError, setLoadError]     = useState<string | null>(null);

  // IR slots B / C / D
  const [slots, setSlots] = useState<Record<SlotId, IRSlot>>({
    B: makeSlot('B'),
    C: makeSlot('C'),
    D: makeSlot('D'),
  });

  // Shared processing config
  const [routing, setRouting]           = useState<RoutingConfiguration>({ mode: 'mono-stereo', monoSumLaw: 'linear' });
  const [preprocessing, setPreprocessing] = useState<PreprocessingConfiguration>(defaultPreprocessing());
  const [gain, setGain]                 = useState<GainConfiguration>(defaultGain());
  const [targetSR, setTargetSR]         = useState<number | null>(null);
  const [exportBitDepth, setExportBitDepth] = useState<ExportBitDepth>(24);
  const [dither, setDither]             = useState(true);

  // Rendering state
  const [anyRendering, setAnyRendering] = useState(false);

  // Helper: update a single slot field
  const updateSlot = useCallback((id: SlotId, patch: Partial<IRSlot>) => {
    setSlots(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  // Load source
  const handleSourceFile = useCallback(async (file: File) => {
    setLoadError(null);
    try {
      const asset = await loadSourceAsset(file, 'conventional');
      setSourceAsset(asset);
      // Auto-pick routing based on first loaded IR slot
      const firstIR = IR_SLOTS.map(id => slots[id].ir).find(Boolean);
      if (firstIR) autoPickRouting(asset.channelCount, firstIR.channelCount, firstIR.layout.kind, setRouting);
    } catch (e) {
      setLoadError(`Source: ${(e as Error).message}`);
    }
  }, [slots]);

  // Load IR into a slot
  const handleIRFile = useCallback(async (slotId: SlotId, file: File) => {
    updateSlot(slotId, { error: null, result: null });
    try {
      const asset = await loadIRAsset(file);
      updateSlot(slotId, { ir: asset });
      if (sourceAsset) autoPickRouting(sourceAsset.channelCount, asset.channelCount, asset.layout.kind, setRouting);
    } catch (e) {
      updateSlot(slotId, { error: (e as Error).message });
    }
  }, [sourceAsset, updateSlot]);

  // Confirm IR layout for a slot
  const confirmLayout = (slotId: SlotId, kind: ChannelLayoutKind) => {
    const ir = slots[slotId].ir;
    if (!ir) return;
    updateSlot(slotId, { ir: { ...ir, layout: { ...ir.layout, kind, userConfirmed: true } } });
    if (sourceAsset) autoPickRouting(sourceAsset.channelCount, ir.channelCount, kind, setRouting);
  };

  // Render all loaded slots
  const handleRenderAll = async () => {
    if (!sourceAsset) return;
    const toRender = IR_SLOTS.filter(id => slots[id].ir !== null);
    if (toRender.length === 0) return;

    setAnyRendering(true);

    // Render slots in parallel
    await Promise.all(toRender.map(async (slotId) => {
      const ir = slots[slotId].ir!;
      updateSlot(slotId, { rendering: true, error: null, result: null, progress: null });

      const srConfig: SampleRateConfig = {
        sourceSampleRate: sourceAsset.sampleRate,
        irSampleRate: ir.sampleRate,
        targetSampleRate: targetSR ?? Math.min(sourceAsset.sampleRate, ir.sampleRate),
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
        const r = await renderConvolution(
          sourceAsset, ir, config,
          (p) => updateSlot(slotId, { progress: p })
        );
        updateSlot(slotId, { result: r, rendering: false, progress: null });
      } catch (e) {
        updateSlot(slotId, { error: (e as Error).message, rendering: false, progress: null });
      }
    }));

    setAnyRendering(false);
  };

  // Export a single slot result
  const handleExport = (slotId: SlotId) => {
    const result = slots[slotId].result;
    if (!result?.wavBlob) return;
    const label = slots[slotId].label.replace(/[^a-z0-9_-]/gi, '_');
    const url = URL.createObjectURL(result.wavBlob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `${result.outputAsset.filename.replace(/\.wav$/i, '')}_${label}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Routing options based on source + first available IR
  const firstIR = IR_SLOTS.map(id => slots[id].ir).find(Boolean) ?? null;
  const availableModes = sourceAsset && firstIR
    ? availableRoutingModes(sourceAsset.channelCount, firstIR.channelCount)
    : [];

  const loadedSlots   = IR_SLOTS.filter(id => slots[id].ir !== null);
  const renderedSlots = IR_SLOTS.filter(id => slots[id].result !== null);
  const canRender     = !!sourceAsset && loadedSlots.length > 0 && !anyRendering;

  // Input warnings
  const inputWarnings: ProcessingWarning[] = [];
  if (sourceAsset?.kind === 'conventional') {
    inputWarnings.push({
      code: 'COMMERCIAL_SOURCE', severity: 'info',
      message: 'Conventional recording loaded.',
      detail: 'This recording may contain pre-existing reverberation and mastering. The convolved result is an experiential impression, not a strict acoustic reconstruction.',
    });
  }
  if (routing.mode.includes('binaural')) {
    inputWarnings.push({ code: 'BINAURAL_NOTE', severity: 'info', message: 'Binaural output — use headphones.', detail: 'Loudspeaker playback will not reproduce the intended binaural ear signals.' });
  }

  return (
    <div className="app">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="site-header">
        <p className="site-header__eyebrow">Acoustic Convolution Tool — v0.1.0</p>
        <h1 className="site-header__title">Room Convolver</h1>
        <p className="site-header__subtitle">
          Combine source audio with measured room impulse responses. Compare up to three room options against the dry source.
        </p>
        <div className="site-header__privacy" role="note">
          <span className="privacy-dot" aria-hidden="true" />
          All processing is local. No audio leaves your browser.
        </div>
      </header>

      {/* ── Mode toggle ─────────────────────────────────────────────────── */}
      <div className="mode-toggle" role="group" aria-label="Interface mode">
        <button className={`mode-toggle__btn${mode === 'basic' ? ' active' : ''}`} onClick={() => setMode('basic')} type="button">Basic</button>
        <button className={`mode-toggle__btn${mode === 'advanced' ? ' active' : ''}`} onClick={() => setMode('advanced')} type="button">Advanced</button>
      </div>

      {/* ── Load error ──────────────────────────────────────────────────── */}
      {loadError && (
        <div className="warning-item error" style={{ marginBottom: '1rem' }}>
          <span className="warning-item__icon">✕</span>
          <div>{loadError}</div>
        </div>
      )}

      {/* ── 01 Source ───────────────────────────────────────────────────── */}
      <section className="panel" aria-labelledby="source-heading">
        <div className="panel__header">
          <span className="panel__number">01</span>
          <h2 className="panel__title" id="source-heading">
            <span className="slot-badge slot-badge--a">A</span>
            Source material — Dry
          </h2>
          <span className={`panel__status ${sourceAsset ? 'ready' : 'pending'}`}>
            {sourceAsset ? '✓ loaded' : 'no file'}
          </span>
        </div>
        <div className="panel__body">
          {!sourceAsset ? (
            <>
              <p style={{ fontSize: '0.8125rem', color: 'var(--stone)', marginBottom: '0.75rem' }}>
                Upload the audio you want to place in the measured rooms. This will always be Option A (dry) in the comparison.
              </p>
              <UploadZone onFile={handleSourceFile} hint="WAV · 16/24/32-bit PCM or float" label="Upload source audio" />
            </>
          ) : (
            <>
              <div className="asset-loaded">
                <span className="asset-loaded__name">📄 {sourceAsset.filename}</span>
                <button className="asset-loaded__clear" onClick={() => { setSourceAsset(null); }} type="button">Remove</button>
              </div>
              <AssetMeta asset={sourceAsset} />
              {sourceAsset.channels[0] && <WaveformCanvas channel={sourceAsset.channels[0]} />}
              <div style={{ marginTop: '0.875rem' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--stone)', marginBottom: '0.4rem' }}>Source type</p>
                <div className="source-type-select" role="group">
                  {[
                    { kind: 'anechoic',     label: 'Dry / anechoic',          desc: 'Best for auralisation' },
                    { kind: 'conventional', label: 'Conventional recording',   desc: 'Already contains room acoustics' },
                  ].map(({ kind, label, desc }) => (
                    <button key={kind} className={`source-type-btn${sourceAsset.kind === kind ? ' selected' : ''}`}
                      onClick={() => setSourceAsset({ ...sourceAsset, kind: kind as 'anechoic' | 'conventional' })}
                      type="button" title={desc}>{label}</button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── 02 IR Slots B / C / D ────────────────────────────────────────── */}
      <section aria-label="Room impulse response options">
        <div style={{ marginBottom: '0.5rem', display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 'normal' }}>Room impulse responses</h2>
          <span style={{ fontSize: '0.75rem', color: 'var(--stone)' }}>— load one, two or three</span>
        </div>

        <div className="ir-slots-grid">
          {IR_SLOTS.map(slotId => (
            <IRSlotPanel
              key={slotId}
              slot={slots[slotId]}
              sourceLoaded={!!sourceAsset}
              onFile={(file) => handleIRFile(slotId, file)}
              onRemove={() => updateSlot(slotId, { ir: null, result: null, error: null })}
              onLabelChange={(label) => updateSlot(slotId, { label })}
              onConfirmLayout={(kind) => confirmLayout(slotId, kind)}
              onExport={() => handleExport(slotId)}
            />
          ))}
        </div>
      </section>

      {/* ── 03 Routing (advanced) ───────────────────────────────────────── */}
      {sourceAsset && loadedSlots.length > 0 && (
        <section className="panel" aria-labelledby="routing-heading">
          <div className="panel__header">
            <span className="panel__number">03</span>
            <h2 className="panel__title" id="routing-heading">Routing</h2>
            {mode === 'basic' && (
              <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--stone)' }}>
                {ROUTING_LABELS[routing.mode]?.name ?? routing.mode}
              </span>
            )}
          </div>
          <div className="panel__body">
            {mode === 'basic' ? (
              <p style={{ fontSize: '0.8125rem', color: 'var(--stone)' }}>
                {ROUTING_LABELS[routing.mode]?.desc ?? ''} Switch to Advanced mode to change routing.
              </p>
            ) : (
              <>
                <p style={{ fontSize: '0.8125rem', color: 'var(--stone)', marginBottom: '1rem' }}>
                  Routing applies to all IR slots equally.
                </p>
                <div className="routing-grid" role="radiogroup" aria-label="Routing mode">
                  {availableModes.map(m => (
                    <div key={m}
                      className={`routing-option${routing.mode === m ? ' selected' : ''}`}
                      onClick={() => setRouting({ ...routing, mode: m })}
                      role="radio" aria-checked={routing.mode === m} tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setRouting({ ...routing, mode: m }); }}>
                      <span className="routing-option__mode">{ROUTING_LABELS[m]?.name ?? m}</span>
                      <span className="routing-option__desc">{ROUTING_LABELS[m]?.desc ?? ''}</span>
                    </div>
                  ))}
                </div>
                {routing.mode.includes('monosum') && (
                  <div style={{ marginTop: '1rem' }}>
                    <div className="control-row">
                      <label htmlFor="monosum-law">Mono sum law</label>
                      <select id="monosum-law" value={routing.monoSumLaw}
                        onChange={e => setRouting({ ...routing, monoSumLaw: e.target.value as 'linear' | 'equal-power' })}>
                        <option value="linear">Linear (L+R)/2 — preserves mono-compatible level</option>
                        <option value="equal-power">Equal power (L+R)/√2 — preserves power of independent signals</option>
                      </select>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {/* ── 04 Processing options (advanced only) ───────────────────────── */}
      {mode === 'advanced' && sourceAsset && loadedSlots.length > 0 && (
        <section className="panel" aria-labelledby="processing-heading">
          <div className="panel__header">
            <span className="panel__number">04</span>
            <h2 className="panel__title" id="processing-heading">Processing options</h2>
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--stone)' }}>applies to all slots</span>
          </div>
          <div className="panel__body">

            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>Sample rate</h3>
            <div className="control-row">
              <label htmlFor="sr-target">Target sample rate</label>
              <select id="sr-target" value={targetSR ?? 0}
                onChange={e => { const v = parseInt(e.target.value); setTargetSR(v === 0 ? null : v); }}>
                <option value={0}>Lowest (recommended)</option>
                <option value={44100}>44.1 kHz</option>
                <option value={48000}>48 kHz</option>
                <option value={88200}>88.2 kHz</option>
                <option value={96000}>96 kHz</option>
              </select>
            </div>

            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>IR onset</h3>
            <div className="control-row">
              <label htmlFor="onset-mode">Onset mode</label>
              <select id="onset-mode" value={preprocessing.onsetMode}
                onChange={e => setPreprocessing({ ...preprocessing, onsetMode: e.target.value as PreprocessingConfiguration['onsetMode'] })}>
                <option value="preserve">Preserve absolute delay</option>
                <option value="auto">Auto-detect onset (recommended)</option>
                <option value="manual">Manual onset frame</option>
              </select>
            </div>
            {preprocessing.onsetMode === 'auto' && (
              <div className="control-row">
                <label htmlFor="predelay">Pre-delay to retain (ms)</label>
                <input id="predelay" type="number" min={0} max={500} step={1}
                  value={Math.round(preprocessing.preDelayFrames / 48)}
                  onChange={e => setPreprocessing({ ...preprocessing, preDelayFrames: Math.round(parseFloat(e.target.value) * 48) })}
                  style={{ width: '80px' }} />
                <span className="control-value">ms</span>
              </div>
            )}

            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>IR preprocessing</h3>
            <div className="control-row">
              <label htmlFor="remove-dc">
                <input id="remove-dc" type="checkbox" checked={preprocessing.removeDC}
                  onChange={e => setPreprocessing({ ...preprocessing, removeDC: e.target.checked })}
                  style={{ marginRight: '0.4rem' }} />
                Remove DC offset
              </label>
            </div>
            <div className="control-row">
              <label htmlFor="hp-hz">High-pass filter</label>
              <select id="hp-hz" value={preprocessing.highPassHz ?? 0}
                onChange={e => { const v = parseFloat(e.target.value); setPreprocessing({ ...preprocessing, highPassHz: v === 0 ? null : v }); }}>
                <option value={0}>Off</option>
                <option value={20}>20 Hz (subsonic removal)</option>
                <option value={40}>40 Hz</option>
                <option value={80}>80 Hz (handling noise)</option>
              </select>
            </div>

            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>Gain</h3>
            <div className="control-row">
              <label htmlFor="gain-mode">Gain mode</label>
              <select id="gain-mode" value={gain.mode}
                onChange={e => setGain({ ...gain, mode: e.target.value as GainConfiguration['mode'] })}>
                <option value="preserve">Preserve linear gain</option>
                <option value="peak-normalise">Peak normalise</option>
                <option value="loudness-normalise">Loudness normalise (approx.)</option>
              </select>
            </div>
            {gain.mode === 'peak-normalise' && (
              <div className="control-row">
                <label htmlFor="peak-target">Peak target</label>
                <select id="peak-target" value={gain.peakTargetDbFS}
                  onChange={e => setGain({ ...gain, peakTargetDbFS: parseFloat(e.target.value) })}>
                  <option value={-1}>-1 dBFS</option>
                  <option value={-3}>-3 dBFS</option>
                  <option value={-6}>-6 dBFS</option>
                </select>
              </div>
            )}

            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>Export</h3>
            <div className="control-row">
              <label htmlFor="bit-depth">Bit depth</label>
              <select id="bit-depth" value={exportBitDepth}
                onChange={e => setExportBitDepth(parseInt(e.target.value) as ExportBitDepth)}>
                <option value={16}>16-bit PCM</option>
                <option value={24}>24-bit PCM (recommended)</option>
                <option value={32}>32-bit float (lossless)</option>
              </select>
            </div>
            {exportBitDepth < 32 && (
              <div className="control-row">
                <label htmlFor="dither">
                  <input id="dither" type="checkbox" checked={dither}
                    onChange={e => setDither(e.target.checked)} style={{ marginRight: '0.4rem' }} />
                  Apply TPDF dither
                </label>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Input warnings ───────────────────────────────────────────────── */}
      {inputWarnings.length > 0 && <WarningList warnings={inputWarnings} />}

      {/* ── 05 Render ────────────────────────────────────────────────────── */}
      {sourceAsset && loadedSlots.length > 0 && (
        <section className="panel" aria-labelledby="render-heading">
          <div className="panel__header">
            <span className="panel__number">05</span>
            <h2 className="panel__title" id="render-heading">Render</h2>
            {renderedSlots.length > 0 && (
              <span className="panel__status ready">✓ {renderedSlots.length} rendered</span>
            )}
          </div>
          <div className="panel__body">
            <p style={{ fontSize: '0.8125rem', color: 'var(--stone)', marginBottom: '1rem' }}>
              Renders all loaded IR slots using the same source and settings.
              {loadedSlots.length > 1 && ` ${loadedSlots.length} slots will be processed.`}
            </p>

            {/* Per-slot progress */}
            {IR_SLOTS.filter(id => slots[id].rendering || slots[id].progress).map(id => (
              <div key={id} style={{ marginBottom: '0.75rem' }}>
                <p className="progress-label">
                  <span className="slot-badge slot-badge--sm">{id}</span>
                  {' '}{slots[id].label} — {slots[id].progress?.stage ?? 'Starting…'}
                </p>
                <div className="progress-bar">
                  <div className="progress-bar__fill"
                    style={{ width: `${(slots[id].progress?.fraction ?? 0) * 100}%` }}
                    role="progressbar"
                    aria-valuenow={Math.round((slots[id].progress?.fraction ?? 0) * 100)}
                    aria-valuemin={0} aria-valuemax={100} />
                </div>
              </div>
            ))}

            <button className="btn btn--amber btn--large" onClick={handleRenderAll} disabled={!canRender} type="button">
              {anyRendering
                ? <><span className="spinner" aria-hidden="true" /> Rendering…</>
                : `Render ${loadedSlots.length === 1 ? 'option' : `${loadedSlots.length} options`}`}
            </button>

            {/* Per-slot errors */}
            {IR_SLOTS.filter(id => slots[id].error).map(id => (
              <div key={id} className="warning-item error" style={{ marginTop: '0.75rem' }}>
                <span className="warning-item__icon">✕</span>
                <div>
                  <div><strong>{slots[id].label}</strong> failed</div>
                  <div className="warning-item__detail">{slots[id].error}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 06 Compare & Preview ─────────────────────────────────────────── */}
      {renderedSlots.length > 0 && sourceAsset && (
        <section className="panel" aria-labelledby="compare-heading">
          <div className="panel__header">
            <span className="panel__number">06</span>
            <h2 className="panel__title" id="compare-heading">Compare and preview</h2>
          </div>
          <div className="panel__body">
            <MultiIRPreview
              sourceAsset={sourceAsset}
              slots={slots}
              renderedSlotIds={renderedSlots}
            />
          </div>
        </section>
      )}

      {/* ── 07 Export ────────────────────────────────────────────────────── */}
      {renderedSlots.length > 0 && (
        <section className="panel" aria-labelledby="export-heading">
          <div className="panel__header">
            <span className="panel__number">07</span>
            <h2 className="panel__title" id="export-heading">Export</h2>
          </div>
          <div className="panel__body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {renderedSlots.map(id => {
                const r = slots[id].result!;
                return (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', paddingBottom: '0.75rem', borderBottom: '1px solid var(--rule)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1 }}>
                      <span className="slot-badge">{id}</span>
                      <div>
                        <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', fontWeight: 600 }}>{slots[id].label}</p>
                        <p style={{ fontSize: '0.75rem', color: 'var(--stone)' }}>
                          {r.outputAsset.channelCount} ch · {(r.outputAsset.sampleRate / 1000).toFixed(1)} kHz ·
                          {exportBitDepth}-bit · {r.outputAsset.durationSeconds.toFixed(1)} s ·
                          ~{((r.outputAsset.frameCount * r.outputAsset.channelCount * exportBitDepth / 8) / 1024 / 1024).toFixed(1)} MB ·
                          Peak {formatDbFS(r.outputAsset.peak)}
                        </p>
                      </div>
                    </div>
                    <button className="btn btn--primary" onClick={() => handleExport(id)} type="button">
                      ↓ Download WAV
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* ── 08 Processing report (advanced) ─────────────────────────────── */}
      {mode === 'advanced' && renderedSlots.length > 0 && (
        <section className="panel" aria-labelledby="report-heading">
          <div className="panel__header">
            <span className="panel__number">08</span>
            <h2 className="panel__title" id="report-heading">Processing report</h2>
          </div>
          <div className="panel__body">
            {renderedSlots.map(id => (
              <details key={id} style={{ marginBottom: '1rem' }}>
                <summary>
                  <span className="slot-badge slot-badge--sm">{id}</span>
                  {' '}{slots[id].label}
                </summary>
                <div style={{ marginTop: '0.75rem' }}>
                  <ReportDisplay report={slots[id].result!.report} />
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      {/* ── About ────────────────────────────────────────────────────────── */}
      <section style={{ marginTop: '2rem' }}>
        <details>
          <summary>About methodology and limitations</summary>
          <div style={{ fontSize: '0.8125rem', color: 'var(--stone)', lineHeight: 1.65, maxWidth: '70ch', marginTop: '0.75rem' }}>
            <p style={{ marginBottom: '0.75rem' }}>
              <strong style={{ color: 'var(--ink)' }}>Convolution method.</strong>{' '}
              Partitioned overlap-add FFT convolution, Float32 throughout. Output length is N_source + N_IR − 1. Full reverberant tail preserved.
            </p>
            <p style={{ marginBottom: '0.75rem' }}>
              <strong style={{ color: 'var(--ink)' }}>Sample-rate conversion.</strong>{' '}
              Lanczos-windowed sinc interpolation. All channels resampled identically to preserve inter-channel timing.
            </p>
            <p style={{ marginBottom: '0.75rem' }}>
              <strong style={{ color: 'var(--ink)' }}>Calibration.</strong>{' '}
              No output is absolutely calibrated for SPL unless source and IR include valid calibration metadata. Normalised audio is suitable for listening comparisons only.
            </p>
            <p>
              <strong style={{ color: 'var(--ink)' }}>Privacy.</strong>{' '}
              All processing is local. Files do not leave your browser. No analytics collected.
            </p>
          </div>
        </details>
      </section>

      <footer className="site-footer">
        <span>Room Convolver v0.1.0</span>
        <span>All processing is local and private</span>
        <span>WAV · PCM 16/24-bit · IEEE Float 32-bit</span>
      </footer>
    </div>
  );
}

// ── IR Slot Panel component ──────────────────────────────────────────────────

interface IRSlotPanelProps {
  slot: IRSlot;
  sourceLoaded: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
  onLabelChange: (label: string) => void;
  onConfirmLayout: (kind: ChannelLayoutKind) => void;
  onExport: () => void;
}

function IRSlotPanel({ slot, sourceLoaded, onFile, onRemove, onLabelChange, onConfirmLayout }: IRSlotPanelProps) {
  const { id, label, ir, result, rendering, error, progress } = slot;

  return (
    <div className="panel ir-slot-panel">
      <div className="panel__header">
        <span className="slot-badge">{id}</span>
        <input
          className="slot-label-input"
          value={label}
          onChange={e => onLabelChange(e.target.value)}
          aria-label={`Label for option ${id}`}
          maxLength={40}
        />
        {result && <span className="panel__status ready">✓ rendered</span>}
        {rendering && <span className="panel__status pending"><span className="spinner" style={{ width: 10, height: 10 }} /></span>}
      </div>
      <div className="panel__body">
        {!ir ? (
          <UploadZone
            onFile={onFile}
            hint="WAV impulse response"
            label={`Upload IR for option ${id}`}
            disabled={!sourceLoaded}
          />
        ) : (
          <>
            <div className="asset-loaded">
              <span className="asset-loaded__name">📄 {ir.filename}</span>
              <button className="asset-loaded__clear" onClick={onRemove} type="button">Remove</button>
            </div>

            <AssetMeta asset={ir} showOnset onsetFrame={ir.estimatedOnsetFrame} noiseFloorDb={ir.estimatedNoiseFloor} />

            {ir.channels[0] && <WaveformCanvas channel={ir.channels[0]} color="#5A7BB5" />}

            {/* Format confirmation */}
            {!ir.layout.userConfirmed && ir.channelCount >= 2 && (
              <div className="format-confirm">
                <p className="format-confirm__label">Confirm format</p>
                <div className="format-select" role="group">
                  {LAYOUT_OPTIONS.map(({ value, label: lbl }) => (
                    <button key={value}
                      className={`format-btn${ir.layout.kind === value ? ' selected' : ''}`}
                      onClick={() => onConfirmLayout(value)} type="button">{lbl}</button>
                  ))}
                </div>
              </div>
            )}
            {ir.layout.userConfirmed && (
              <p style={{ fontSize: '0.75rem', color: 'var(--green)', marginTop: '0.5rem' }}>
                ✓ Format confirmed: {ir.layout.kind}
              </p>
            )}

            {/* Render progress inline */}
            {progress && (
              <div style={{ marginTop: '0.75rem' }}>
                <p className="progress-label">{progress.stage}</p>
                <div className="progress-bar">
                  <div className="progress-bar__fill" style={{ width: `${progress.fraction * 100}%` }} />
                </div>
              </div>
            )}

            {/* Result waveform */}
            {result && result.outputAsset.channels[0] && (
              <div style={{ marginTop: '0.75rem' }}>
                <p style={{ fontSize: '0.6875rem', fontFamily: 'var(--font-mono)', color: 'var(--stone)', marginBottom: '0.25rem' }}>
                  Output · Peak {formatDbFS(result.outputAsset.peak)} · {result.outputAsset.durationSeconds.toFixed(1)} s
                </p>
                <WaveformCanvas channel={result.outputAsset.channels[0]} color="#2D7A4F" height={48} />
              </div>
            )}

            {error && (
              <div className="warning-item error" style={{ marginTop: '0.5rem' }}>
                <span className="warning-item__icon">✕</span>
                <div className="warning-item__detail">{error}</div>
              </div>
            )}
          </>
        )}
      </div>
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
  let routingMode: RoutingMode = 'mono-mono';
  if (sourceChannels === 1) {
    if (irChannels === 1) routingMode = 'mono-mono';
    else if (irKind === 'binaural') routingMode = 'mono-binaural';
    else if (irChannels >= 2) routingMode = 'mono-stereo';
    if (irChannels === 4 || irChannels === 9 || irChannels === 16) routingMode = 'mono-ambisonic';
  } else {
    if (irKind === 'binaural') routingMode = 'stereo-monosum-binaural';
    else routingMode = 'stereo-monosum-stereo';
  }
  setRouting({ mode: routingMode, monoSumLaw: 'linear' });
}
