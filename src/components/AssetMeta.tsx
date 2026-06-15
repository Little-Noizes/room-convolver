import type { AudioAsset } from '../models/types.js';
import { linearToDb } from '../audio/metering/metering.js';
import { formatDuration, formatDbFS } from '../audio/assetLoader.js';
import { MeteringBar } from './MeteringBar.js';

interface AssetMetaProps {
  asset: AudioAsset;
  showOnset?: boolean;
  onsetFrame?: number | null;
  noiseFloorDb?: number | null;
}

function fmt(v: number, dec = 1): string {
  return Number.isFinite(v) ? v.toFixed(dec) : '—';
}

export function AssetMeta({ asset, onsetFrame, noiseFloorDb }: AssetMetaProps) {
  const rmsDb      = linearToDb(asset.rms);
  const onsetMs    = onsetFrame != null ? ((onsetFrame / asset.sampleRate) * 1000) : null;

  return (
    <>
    <div className="asset-meta">
      <div className="meta-item">
        <span className="meta-item__label">Filename</span>
        <span className="meta-item__value" title={asset.filename}>
          {asset.filename.length > 24 ? asset.filename.slice(0, 22) + '…' : asset.filename}
        </span>
      </div>
      <div className="meta-item">
        <span className="meta-item__label">Duration</span>
        <span className="meta-item__value">{formatDuration(asset.durationSeconds)}</span>
      </div>
      <div className="meta-item">
        <span className="meta-item__label">Sample rate</span>
        <span className="meta-item__value">{(asset.sampleRate / 1000).toFixed(1)} kHz</span>
      </div>
      <div className="meta-item">
        <span className="meta-item__label">Channels</span>
        <span className="meta-item__value">{asset.channelCount}</span>
      </div>
      <div className="meta-item">
        <span className="meta-item__label">Peak</span>
        <span className={`meta-item__value${asset.peak >= 1.0 ? ' error' : asset.peak >= 0.99 ? ' warn' : ''}`}>
          {formatDbFS(asset.peak)}
        </span>
      </div>
      <div className="meta-item">
        <span className="meta-item__label">RMS</span>
        <span className="meta-item__value">{fmt(rmsDb)} dBFS</span>
      </div>
      {onsetMs != null && (
        <div className="meta-item">
          <span className="meta-item__label">Est. onset</span>
          <span className="meta-item__value">{onsetMs.toFixed(1)} ms</span>
        </div>
      )}
      {noiseFloorDb != null && (
        <div className="meta-item">
          <span className="meta-item__label">Noise floor</span>
          <span className="meta-item__value">{fmt(noiseFloorDb)} dBFS</span>
        </div>
      )}
    </div>
    <div style={{ marginTop: '0.6rem' }}>
      <MeteringBar peakLinear={asset.peak} rmsLinear={asset.rms} />
    </div>
    </>
  );
}
