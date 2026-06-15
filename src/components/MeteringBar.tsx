import { linearToDb } from '../audio/metering/metering.js';

interface MeteringBarProps {
  peakLinear: number;
  rmsLinear: number;
  label?: string;
}

export function MeteringBar({ peakLinear, rmsLinear, label }: MeteringBarProps) {
  const peakDb = linearToDb(peakLinear);
  const rmsDb  = linearToDb(rmsLinear);

  // Map dBFS range -60..0 to 0..100%
  const dbToPercent = (db: number) => Math.max(0, Math.min(100, (db + 60) / 60 * 100));

  const peakPct  = dbToPercent(peakDb);
  const rmsPct   = dbToPercent(rmsDb);
  const isClip   = peakLinear >= 1.0;
  const isHot    = peakLinear >= 0.99;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.35rem 0' }}>
      {label && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.625rem', color: 'var(--stone)', minWidth: '28px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {label}
        </span>
      )}
      <div style={{ flex: 1, height: '8px', background: 'var(--rule)', borderRadius: '2px', position: 'relative', overflow: 'hidden' }}>
        {/* RMS bar */}
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${rmsPct}%`,
          background: 'rgba(181,129,58,0.3)',
          borderRadius: '2px',
        }} />
        {/* Peak bar */}
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${peakPct}%`,
          background: isClip ? 'var(--red)' : isHot ? 'var(--amber)' : 'var(--amber)',
          opacity: isClip ? 1 : 0.7,
          borderRadius: '2px',
        }} />
      </div>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.6875rem',
        color: isClip ? 'var(--red)' : isHot ? 'var(--amber-dim)' : 'var(--stone)',
        minWidth: '60px',
        textAlign: 'right',
      }}>
        {isFinite(peakDb) ? `${peakDb.toFixed(1)} dBFS` : '−∞'}
        {isClip && ' CLIP'}
      </span>
    </div>
  );
}
