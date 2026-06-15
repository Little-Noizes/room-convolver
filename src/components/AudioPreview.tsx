/**
 * AudioPreview
 *
 * Plays audio from Float32 channel arrays using the Web Audio API.
 * Supports switching between dry (source) and wet (rendered) signals
 * without changing playback position (A/B comparison).
 *
 * Does NOT resample on playback — the audio context sample rate may
 * differ from the file sample rate, which could cause pitch shift.
 * TODO Phase 2: Resample to AudioContext rate before preview.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { AudioAsset } from '../models/types.js';

interface AudioPreviewProps {
  dryAsset: AudioAsset | null;
  wetAsset: AudioAsset | null;
}

export function AudioPreview({ dryAsset, wetAsset }: AudioPreviewProps) {
  const [playing, setPlaying]       = useState(false);
  const [abMode, setAbMode]         = useState<'dry' | 'wet'>('wet');
  const [position, setPosition]     = useState(0); // 0..1
  const [duration, setDuration]     = useState(0);

  const ctxRef    = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef  = useRef(0);
  const startOffsetRef = useRef(0);
  const animRef   = useRef<number>(0);

  const activeAsset = abMode === 'dry' ? dryAsset : wetAsset;

  const getOrCreateContext = () => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      ctxRef.current = new AudioContext();
    }
    return ctxRef.current;
  };

  const buildAudioBuffer = useCallback((asset: AudioAsset): AudioBuffer => {
    const ctx = getOrCreateContext();
    // If asset sample rate differs from context, warn but proceed
    const buf = ctx.createBuffer(asset.channelCount, asset.frameCount, asset.sampleRate);
    for (let c = 0; c < asset.channelCount; c++) {
      buf.copyToChannel(asset.channels[c] as Float32Array<ArrayBuffer>, c);
    }
    return buf;
  }, []);

  const stop = useCallback(() => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch {}
      sourceRef.current = null;
    }
    cancelAnimationFrame(animRef.current);
    setPlaying(false);
  }, []);

  const play = useCallback((offset = 0) => {
    if (!activeAsset) return;
    stop();

    const ctx = getOrCreateContext();
    if (ctx.state === 'suspended') ctx.resume();

    const buffer  = buildAudioBuffer(activeAsset);
    const source  = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      setPlaying(false);
      setPosition(0);
    };
    source.start(0, offset);
    sourceRef.current  = source;
    startTimeRef.current   = ctx.currentTime - offset;
    startOffsetRef.current = offset;
    setDuration(buffer.duration);
    setPlaying(true);

    const tick = () => {
      const elapsed = ctx.currentTime - startTimeRef.current;
      setPosition(Math.min(1, elapsed / buffer.duration));
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
  }, [activeAsset, stop, buildAudioBuffer]);

  // When AB mode changes, restart at current position
  const switchAB = useCallback((mode: 'dry' | 'wet') => {
    const wasPlaying = playing;
    const currentOffset = position * duration;
    stop();
    setAbMode(mode);
    if (wasPlaying) {
      // Brief timeout to allow state to settle
      setTimeout(() => play(currentOffset), 50);
    }
  }, [playing, position, duration, stop, play]);

  useEffect(() => {
    return () => {
      stop();
      ctxRef.current?.close();
    };
  }, [stop]);

  // Reset when assets change
  useEffect(() => {
    stop();
    setPosition(0);
  }, [dryAsset, wetAsset]);

  const canPlay = activeAsset !== null;

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* A/B toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div className="ab-toggle" role="group" aria-label="Dry/wet comparison">
          <button
            className={`ab-btn${abMode === 'dry' ? ' active' : ''}`}
            onClick={() => switchAB('dry')}
            disabled={!dryAsset}
            type="button"
            aria-pressed={abMode === 'dry'}
          >
            A — Dry
          </button>
          <button
            className={`ab-btn${abMode === 'wet' ? ' active' : ''}`}
            onClick={() => switchAB('wet')}
            disabled={!wetAsset}
            type="button"
            aria-pressed={abMode === 'wet'}
          >
            B — Room
          </button>
        </div>

        <div className="preview-controls">
          <button
            className="btn btn--primary"
            onClick={() => playing ? stop() : play(position * duration)}
            disabled={!canPlay}
            type="button"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button
            className="btn"
            onClick={() => { stop(); setPosition(0); }}
            disabled={!canPlay}
            type="button"
            aria-label="Stop"
          >
            ■ Stop
          </button>
        </div>

        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--stone)' }}>
          {formatTime(position * duration)} / {formatTime(duration)}
        </span>
      </div>

      {/* Scrub bar */}
      <div style={{ position: 'relative' }}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={position}
          onChange={(e) => {
            const p = parseFloat(e.target.value);
            setPosition(p);
            if (playing) play(p * duration);
          }}
          disabled={!canPlay}
          style={{ width: '100%', accentColor: 'var(--amber)' }}
          aria-label="Playback position"
        />
      </div>

      {activeAsset && activeAsset.sampleRate !== (ctxRef.current?.sampleRate ?? activeAsset.sampleRate) && (
        <p style={{ fontSize: '0.75rem', color: 'var(--stone)' }}>
          Note: browser audio context runs at {ctxRef.current?.sampleRate ?? '?'} Hz;
          file is {activeAsset.sampleRate} Hz — playback may have slight pitch difference.
          Export uses the correct sample rate.
        </p>
      )}

      {!wetAsset && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--stone)', fontStyle: 'italic' }}>
          Render the convolution to enable room preview and A/B comparison.
        </p>
      )}
    </div>
  );
}
