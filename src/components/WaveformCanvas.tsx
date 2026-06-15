/**
 * WaveformCanvas
 *
 * Renders an audio channel as a waveform into an HTML canvas.
 * Uses efficient min/max reduction per pixel column to handle
 * very long buffers without iterating every sample.
 *
 * Does not use Web Audio AnalyserNode — this is a static waveform,
 * not a real-time display.
 */

import { useEffect, useRef } from 'react';

interface WaveformCanvasProps {
  channel: Float32Array;
  color?: string;
  height?: number;
  label?: string;
}

export function WaveformCanvas({ channel, color = '#B5813A', height = 72 }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || channel.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr    = window.devicePixelRatio || 1;
    const width  = canvas.clientWidth;
    const h      = canvas.clientHeight;

    canvas.width  = width * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, h);
    ctx.fillStyle = 'var(--cream, #F5F2ED)';
    ctx.fillRect(0, 0, width, h);

    // Zero line
    ctx.strokeStyle = 'rgba(120,115,110,0.2)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(width, h / 2);
    ctx.stroke();

    // Compute min/max per pixel column
    const samplesPerPixel = channel.length / width;
    ctx.fillStyle = color;

    for (let px = 0; px < width; px++) {
      const start = Math.floor(px * samplesPerPixel);
      const end   = Math.floor((px + 1) * samplesPerPixel);
      let min = 0, max = 0;
      for (let i = start; i < end && i < channel.length; i++) {
        const s = channel[i];
        if (s < min) min = s;
        if (s > max) max = s;
      }
      const yMin = (1 - max) / 2 * h;
      const yMax = (1 - min) / 2 * h;
      ctx.fillRect(px, yMin, 1, Math.max(1, yMax - yMin));
    }
  }, [channel, color, height]);

  return (
    <canvas
      ref={canvasRef}
      className="waveform-canvas"
      style={{ height: `${height}px` }}
      aria-label="Audio waveform"
      role="img"
    />
  );
}
