import { Upload } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

// Product photos "Drop photos or click to upload" (60:9381) and Import "Upload file" (60:10177): dashed
// border-strong tile on surface-subtle, upload icon, title + hint; brand tint while dragging.
export interface FileDropProps {
  label: ReactNode;
  hint?: ReactNode;
  accept: string;
  multiple?: boolean;
  /** Bytes; larger files are rejected with `tooLargeMessage`. */
  maxBytes?: number;
  tooLargeMessage?: string;
  disabled?: boolean;
  error?: string | null;
  onFiles: (files: File[]) => void;
  className?: string;
  children?: ReactNode;
}

export function FileDrop({ label, hint, accept, multiple = false, maxBytes, tooLargeMessage = 'This file is too large.', disabled, error, onFiles, className, children }: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [over, setOver] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const take = (list: FileList | null) => {
    if (!list?.length || disabled) return;
    const files = Array.from(list).slice(0, multiple ? undefined : 1);
    if (maxBytes && files.some((f) => f.size > maxBytes)) {
      setLocalError(tooLargeMessage);
      return;
    }
    setLocalError(null);
    onFiles(files);
  };

  const message = error ?? localError;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors',
          over ? 'border-brand-600 bg-brand-50' : 'border-border-strong bg-surface-subtle hover:bg-brand-50/60',
          disabled && 'cursor-not-allowed opacity-60',
          message && 'border-danger',
        )}
      >
        {children ?? (
          <>
            <Upload aria-hidden className="size-5 text-text-secondary" />
            <span className="text-body font-medium text-text-primary">{label}</span>
            {hint && <span className="text-caption text-text-muted">{hint}</span>}
          </>
        )}
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          className="sr-only"
          aria-label={typeof label === 'string' ? label : 'Choose file'}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {message && (
        <p role="alert" className="text-caption text-danger">
          {message}
        </p>
      )}
    </div>
  );
}
