import { X } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { cn } from '../lib/cn';
import { Label } from './Label';

// Product editor Organize · Tags (60:9381) and Customer detail Tags (64:16382): small tag pills + "+ Add tag".
// Enter or comma commits; Backspace on an empty input removes the last tag. Normalisation mirrors the API
// (trimmed, lowercased, unique; contract P4-9).
// `variant="inline"` = Order detail · Details 33:4175: no field box; brand-50 / brand-700 pills (Caption/12 Medium,
// px 8 py 2, gap 6) and a surface-subtle "+ Tag" pill that opens a pill-sized input. The × appears on hover/focus.
export interface TagInputProps {
  label?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  max?: number;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  normalize?: (tag: string) => string;
  variant?: 'field' | 'inline';
  className?: string;
}

const defaultNormalize = (t: string) => t.trim().toLowerCase();

export function TagInput({
  label,
  value,
  onChange,
  max = 20,
  maxLength = 40,
  placeholder = 'Add tag',
  hint,
  error,
  disabled,
  normalize = defaultNormalize,
  variant = 'field',
  className,
}: TagInputProps) {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const id = useId();
  const full = value.length >= max;

  const commit = (raw: string) => {
    const parts = raw.split(',').map(normalize).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) {
      const tag = p.slice(0, maxLength);
      if (!next.includes(tag) && next.length < max) next.push(tag);
    }
    setDraft('');
    if (next.length !== value.length) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  if (variant === 'inline') {
    const feedback = error ? <p className="text-caption text-danger">{error}</p> : hint ? <p className="text-caption text-text-muted">{hint}</p> : null;
    return (
      <div className={cn('flex flex-col gap-1.5', className)}>
        {label && <span className="sr-only">{label}</span>}
        <ul aria-label={label} className="flex flex-wrap items-center gap-1.5">
          {value.map((tag) => (
            <li key={tag} className="group inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-caption font-medium text-brand-700">
              {tag}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${tag}`}
                  onClick={() => onChange(value.filter((t) => t !== tag))}
                  className="-mr-0.5 ml-0 inline-flex w-0 overflow-hidden rounded-full opacity-0 outline-none group-hover:ml-1 group-hover:w-3 group-hover:opacity-100 focus-visible:ml-1 focus-visible:w-3 focus-visible:opacity-100"
                >
                  <X aria-hidden className="size-3 shrink-0" />
                </button>
              )}
            </li>
          ))}
          {!disabled && !full && (
            <li className="inline-flex">
              {adding ? (
                <input
                  id={id}
                  autoFocus
                  value={draft}
                  maxLength={maxLength * 4}
                  aria-label={label ?? placeholder}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setDraft('');
                      setAdding(false);
                    } else onKeyDown(e);
                  }}
                  onBlur={() => {
                    commit(draft);
                    setAdding(false);
                  }}
                  className="h-5 w-24 rounded-full bg-surface-subtle px-2 text-caption font-medium text-text-primary outline-none focus-visible:shadow-focus"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="inline-flex rounded-full bg-surface-subtle px-2 py-0.5 text-caption font-medium text-text-secondary outline-none hover:text-text-primary focus-visible:shadow-focus"
                >
                  {placeholder}
                </button>
              )}
            </li>
          )}
        </ul>
        {feedback}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      <div className={cn('flex min-h-11 flex-wrap items-center gap-1.5 rounded-md border bg-surface-card px-2 py-1.5', error ? 'border-danger' : 'border-border-default', 'focus-within:border-brand-600')}>
        {value.map((tag) => (
          <span key={tag} className="inline-flex h-6 items-center gap-1 rounded-sm bg-surface-subtle pr-1 pl-2 text-caption font-medium text-text-secondary">
            {tag}
            {!disabled && (
              <button type="button" aria-label={`Remove ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))} className="rounded-sm p-0.5 text-text-muted hover:text-text-primary">
                <X aria-hidden className="size-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled && !full && (
          <input
            id={id}
            value={draft}
            maxLength={maxLength * 4}
            placeholder={value.length ? '' : placeholder}
            aria-label={label ? undefined : placeholder}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => commit(draft)}
            className="min-w-24 flex-1 bg-transparent px-1 py-1 text-body text-text-primary outline-none placeholder:text-text-muted"
          />
        )}
      </div>
      {error ? <p className="text-caption text-danger">{error}</p> : hint ? <p className="text-caption text-text-muted">{hint}</p> : null}
    </div>
  );
}
