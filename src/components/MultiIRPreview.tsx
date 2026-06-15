/**
 * MultiIRPreview
 *
 * A/B/C/D comparison player.
 * A is always the dry source.
 * B/C/D are rendered IR results.
 *
 * Switching slots does not change playback position.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { SourceAsset, AudioAsset } from '../models/types.js';
import type { IRSlot, SlotId } from '../app/App.js';
import { WaveformCanvas } from './WaveformCanvas.js';

interface MultiIRPreviewProps {
  sourceAsset: SourceAsset;
  slots: Record<SlotId, IRSlot>;
  renderedSlotIds: SlotId[];
}

type AnySlot = 'A' | SlotId;

export function MultiIRPreview({ sourceAsset, slots, renderedSlotIds }: MultiIRPreviewProps) {
  const [active, setActive]     = useState<AnySlot>('A');
  const [playing, setPlaying]   = useState(false);
  const [position, setPosition] = useState(0); // 0..1
  const [duration, setDuration] = useState(0);

  const ctxRef        = useRef<AudioContext | null>(null);
  const sourceRef     = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef  = useRef(0);
  const animRef       = useRef(0);

  const availableSlots: AnySlot[] = ['A', ...renderedSlotIds];

  const getAsset = (slot: AnySlot): AudioAsset | null => {
    if (slot === 'A') return sourceAsset;
    return slots[slot as SlotId]?.result?.outputAsset ?? null;
  };

  const getLabel = (slot: AnySlot): string => {
    if (slot === 'A') return 'A — Dry';
    return `${slot} — ${slots[slot as SlotId]?.label ?? slot}`;
  };

  const activeAsset = getAsset(active);

  const getCtx = () => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      ctxRef.current = new AudioContext();
    }
    return ctxRef.current;
  };

  const stop = useCallback(() => {
    try { sourceRef.current?.stop(); } catch {}
    sourceRef.current = null;
    cancelAnimationFrame(animRef.current);
    setPlaying(false);
  }, []);

  const play = useCallback((offset = 0) => {
    if (!activeAsset) return;
    stop();

    const ctx = getCtx();
    if (ctx.state === 'suspended') ctx.resume();

    const buf = ctx.createBuffer(activeAsset.channelCount, activeAsset.frameCount, activeAsset.sampleRate);
    for (let c = 0; c < activeAsset.channelCount; c++) {
      buf.copyToChannel(activeAsset.channels[c] as Float32Array<ArrayBuffer>, c);
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => { setPlaying(false); setPosition(0); };
    src.start(0, offset);

    sourceRef.current  = src;
    startTimeRef.current = ctx.currentTime - offset;
    setDuration(buf.duration);
    setPlaying(true);

    const tick = () => {
      const elapsed = ctx.currentTime - startTimeRef.current;
      setPosition(Math.min(1, elapsed / buf.duration));
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
  }, [activeAsset, stop]);

  // Switch slot without changing position
  const switchSlot = useCallback((slot: AnySlot) => {
    const wasPlaying = playing;
    const currentOffset = position * duration;
    stop();
    setActive(slot);
    if (wasPlaying) {
      setTimeout(() => play(currentOffset), 50);
    }
  }, [playing, position, duration, stop, play]);

  useEffect(() => {
    return () => { stop(); ctxRef.current?.close(); };
  }, [stop]);

  useEffect(() => { stop(); setPosition(0); }, [sourceAsset]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${ss}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

      {/* Slot selector */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }} role="group" aria-label="Comparison options">
        {availableSlots.map(slot => (
          <button
            key={slot}
            type="button"
            className={`comparison-slot-btn${active === slot ? ' active' : ''}`}
            onClick={() => switchSlot(slot)}
            aria-pressed={active === slot}
          >
            <span className="slot-badge slot-badge--sm">{slot}</span>
            <span className="comparison-slot-btn__label">{getLabel(slot)}</span>
          </button>
        ))}
      </div>

      {/* Active waveform */}
      {activeAsset?.channels[0] && (
        <div>
          <p style={{ fontSize: '0.6875rem', fontFamily: 'var(--font-mono)', color: 'var(--stone)', marginBottom: '0.25rem' }}>
            {getLabel(active)} · {activeAsset.channelCount} ch · {(activeAsset.sampleRate / 1000).toFixed(1)} kHz · {activeAsset.durationSeconds.toFixed(1)} s
          </p>
          <WaveformCanvas
            channel={activeAsset.channels[0]}
            color={active === 'A' ? '#B5813A' : '#5A7BB5'}
            height={72}
          />
        </div>
      )}

      {/* Transport */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button className="btn btn--primary"
          onClick={() => playing ? stop() : play(position * duration)}
          disabled={!activeAsset} type="button">
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button className="btn"
          onClick={() => { stop(); setPosition(0); }}
          disabled={!activeAsset} type="button">
          ■ Stop
        </button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--stone)' }}>
          {fmt(position * duration)} / {fmt(duration)}
        </span>
      </div>

      {/* Scrub */}
      <input type="range" min={0} max={1} step={0.001} value={position}
        onChange={e => {
          const p = parseFloat(e.target.value);
          setPosition(p);
          if (playing) play(p * duration);
        }}
        disabled={!activeAsset}
        style={{ width: '100%', accentColor: 'var(--amber)' }}
        aria-label="Playback position"
      />

      <p style={{ fontSize: '0.75rem', color: 'var(--stone)', fontStyle: 'italic' }}>
        Switching between options does not change the playback position.
      </p>
    </div>
  );
}
