import { Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { Chip } from './Chip';

// Onboarding 05 Sizes (50:312: S / M / L / XL / XXL chips) and the editor option values (60:9381): Chip 45:8043
// toggles in a wrap row, optional "+ Add" inline input for custom values.
export interface ChipOption {
  value: string;
  label?: string;
}

export interface ChipSelectProps {
  options: ChipOption[];
  value: string[];
  onChange: (value: string[]) => void;
  /** Single choice (radio-like) instead of multi-select. */
  single?: boolean;
  /** Show "+ Add" which lets the user type a custom value (added and selected). */
  allowCustom?: boolean;
  customLabel?: string;
  maxCustomLength?: number;
  max?: number;
  'aria-label': string;
  className?: string;
  size?: 'md' | 'sm';
}

export function ChipSelect({
  options,
  value,
  onChange,
  single = false,
  allowCustom = false,
  customLabel = 'Add',
  maxCustomLength = 40,
  max,
  className,
  size = 'md',
  ...aria
}: ChipSelectProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const toggle = (v: string) => {
    if (single) return onChange(value.includes(v) ? [] : [v]);
    if (value.includes(v)) onChange(value.filter((x) => x !== v));
    else if (max === undefined || value.length < max) onChange([...value, v]);
  };
  const commit = () => {
    const v = draft.trim().slice(0, maxCustomLength);
    setDraft('');
    setAdding(false);
    if (!v) return;
    const existing = options.find((o) => o.value.toLowerCase() === v.toLowerCase());
    const target = existing?.value ?? v;
    if (!value.includes(target)) toggle(target);
  };
  const chipSize = size === 'sm' ? 'px-3 py-1 text-caption' : '';

  return (
    <div role="group" aria-label={aria['aria-label']} className={cn('flex flex-wrap items-center gap-2', className)}>
      {[...options, ...value.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: v }))].map((o) => (
        <Chip key={o.value} selected={value.includes(o.value)} onClick={() => toggle(o.value)} className={chipSize}>
          {o.label ?? o.value}
        </Chip>
      ))}
      {allowCustom &&
        (adding ? (
          <input
            autoFocus
            aria-label={`${customLabel} value`}
            value={draft}
            maxLength={maxCustomLength}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={commit}
            className="h-9 w-28 rounded-full border border-brand-600 px-3 text-body outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={cn('inline-flex items-center gap-1 rounded-full border border-dashed border-border-strong px-3 py-1.5 text-caption font-medium text-text-secondary hover:bg-surface-subtle', size === 'md' && 'py-2')}
          >
            <Plus aria-hidden className="size-3.5" /> {customLabel}
          </button>
        ))}
    </div>
  );
}
