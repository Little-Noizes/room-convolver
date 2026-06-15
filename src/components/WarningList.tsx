import type { ProcessingWarning } from '../models/types.js';

interface WarningListProps {
  warnings: ProcessingWarning[];
}

const ICONS: Record<string, string> = {
  info:    'ℹ',
  warning: '△',
  error:   '✕',
};

export function WarningList({ warnings }: WarningListProps) {
  if (warnings.length === 0) return null;

  return (
    <div className="warning-list" role="status" aria-live="polite">
      {warnings.map((w, i) => (
        <div key={`${w.code}-${i}`} className={`warning-item ${w.severity}`}>
          <span className="warning-item__icon" aria-hidden="true">{ICONS[w.severity]}</span>
          <div>
            <div className="warning-item__text">{w.message}</div>
            {w.detail && (
              <div className="warning-item__detail">{w.detail}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
