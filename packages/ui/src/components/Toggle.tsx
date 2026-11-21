import { cn } from '../lib/cn';

// Figma Toggle 21:202 / Account 148:33916 — 40×24 track, on = brand-500, white knob.
export interface ToggleProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  id?: string;
  className?: string;
}

export function Toggle({ checked, onChange, disabled, label, id, className }: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-500' : 'bg-border-strong',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('size-5 rounded-full bg-surface-card shadow-elevation-1 transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')}
      />
    </button>
  );
}
