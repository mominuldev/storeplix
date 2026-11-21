import { ImageUp, Trash2 } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './Button';

// Figma Settings · Shop identity 61:12261 logo block: preview tile + Upload/Remove buttons + helper.
// Presentational: the caller performs the upload and passes `progress` (0..1) while it runs.
export interface ImageUploadProps {
  label: string;
  /** Current image URL (or a local object URL while uploading). */
  src?: string | null;
  accept: string;
  hint?: ReactNode;
  error?: string | null;
  /** 0..1 while uploading; `null` when idle. */
  progress?: number | null;
  processing?: boolean;
  disabled?: boolean;
  shape?: 'square' | 'rounded';
  previewSize?: number;
  onSelect: (file: File) => void;
  onRemove?: () => void;
  className?: string;
}

export function ImageUpload({
  label,
  src,
  accept,
  hint,
  error,
  progress = null,
  processing = false,
  disabled = false,
  shape = 'rounded',
  previewSize = 72,
  onSelect,
  onRemove,
  className,
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const busy = progress !== null || processing;

  return (
    <div className={cn('flex items-center gap-4', className)}>
      <div
        className={cn(
          'relative flex shrink-0 items-center justify-center overflow-hidden border border-border-default bg-surface-subtle text-text-muted',
          shape === 'rounded' ? 'rounded-lg' : 'rounded-sm',
        )}
        style={{ width: previewSize, height: previewSize }}
      >
        {src ? <img src={src} alt={`${label} preview`} className="size-full object-contain" /> : <ImageUp aria-hidden className="size-6" />}
        {busy && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-surface-subtle">
            <div
              role="progressbar"
              aria-label={`${label} upload progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((progress ?? 1) * 100)}
              className={cn('h-full bg-brand-600 transition-[width]', processing && 'animate-pulse')}
              style={{ width: `${(progress ?? 1) * 100}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-body font-medium text-text-primary">{label}</span>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={accept}
            aria-label={`Upload ${label.toLowerCase()}`}
            className="sr-only"
            disabled={disabled || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onSelect(file);
              e.target.value = '';
            }}
          />
          <Button variant="secondary" size="sm" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
            {busy ? (processing ? 'Processing…' : `Uploading ${Math.round((progress ?? 0) * 100)}%`) : src ? 'Replace' : 'Upload'}
          </Button>
          {src && onRemove && (
            <Button variant="ghost" size="sm" disabled={disabled || busy} leftIcon={<Trash2 aria-hidden className="size-3.5" />} onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        ) : (
          hint && <p className="text-caption text-text-muted">{hint}</p>
        )}
      </div>
    </div>
  );
}
