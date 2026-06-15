import type { ProcessingReport } from '../models/types.js';

interface ReportDisplayProps {
  report: ProcessingReport;
}

export function ReportDisplay({ report: r }: ReportDisplayProps) {
  const lines = [
    `SOURCE`,
    `  ${r.sourceFilename}`,
    `  ${r.sourceChannelCount === 1 ? 'Mono' : 'Stereo'}, ${(r.sourceSampleRate / 1000).toFixed(1)} kHz, ${r.sourceDurationSeconds.toFixed(1)} s`,
    ``,
    `IMPULSE RESPONSE`,
    `  ${r.irFilename}`,
    `  ${r.irChannelCount} channel${r.irChannelCount !== 1 ? 's' : ''}, ${(r.irSampleRate / 1000).toFixed(1)} kHz`,
    `  Format: ${r.irLayout.kind}`,
    r.irLayout.userConfirmed ? `  Format confirmed by user` : `  Format not confirmed — verify before use`,
    ``,
    `PROCESSING`,
    `  Sample rate: ${(r.processingSampleRate / 1000).toFixed(1)} kHz${r.resamplingApplied ? ' (resampling applied)' : ''}`,
    `  Onset: ${r.onsetTreatment}`,
    r.irTrimSeconds != null ? `  IR trimmed to ${r.irTrimSeconds.toFixed(2)} s` : `  IR untrimmed`,
    `  Routing: ${r.routingMode}`,
    `  Gain: ${r.gainMode}`,
    ``,
    `OUTPUT`,
    `  ${r.outputChannelCount} channel${r.outputChannelCount !== 1 ? 's' : ''}, ${(r.outputSampleRate / 1000).toFixed(1)} kHz`,
    `  Duration: ${r.outputDurationSeconds.toFixed(2)} s`,
    `  Export: ${r.exportBitDepth}-bit ${r.exportBitDepth === 32 ? 'float' : 'PCM'} WAV`,
    `  Rendered: ${r.renderDateISO}`,
    `  App version: ${r.appVersion}`,
  ].join('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(lines).catch(() => {});
  };

  const handleDownload = () => {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'render-report.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <pre className="report-block">{lines}</pre>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <button className="btn" onClick={handleCopy} type="button">
          Copy
        </button>
        <button className="btn" onClick={handleDownload} type="button">
          Download JSON
        </button>
      </div>
    </div>
  );
}
