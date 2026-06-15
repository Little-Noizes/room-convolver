import { useRef, useState, type DragEvent, type ChangeEvent } from 'react';

interface UploadZoneProps {
  onFile: (file: File) => void;
  accept?: string;
  hint?: string;
  label?: string;
  disabled?: boolean;
}

export function UploadZone({ onFile, accept = '.wav,.wave', hint, label = 'Upload audio file', disabled }: UploadZoneProps) {
  const inputRef   = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    // Reset so the same file can be re-uploaded
    e.target.value = '';
  };

  return (
    <div
      className={`upload-zone${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
    >
      <div className="upload-zone__icon" aria-hidden="true">⬆</div>
      <p className="upload-zone__label">
        Drag and drop, or <strong>browse</strong>
      </p>
      {hint && <p className="upload-zone__hint">{hint}</p>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={handleChange}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}
