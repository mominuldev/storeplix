import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cn } from '../lib/cn';

// Figma 02 46:8705 / M2 53:831 / L2 57:1050 code boxes — 6 boxes, rounded-lg, Heading/24 digits;
// focused = 2px brand-600. Supports paste, backspace navigation and the numeric keypad.
export interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  label?: string;
  error?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** Box size overrides (Figma: 62×68 on 02, 48×58 on M2, flex×60 on L2/L3). */
  boxClassName?: string;
}

export function OtpInput({
  value,
  onChange,
  length = 6,
  label = 'Verification code',
  error,
  disabled,
  autoFocus,
  className,
  boxClassName,
}: OtpInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  const focus = (i: number) => refs.current[Math.max(0, Math.min(length - 1, i))]?.focus();

  const setAt = (i: number, d: string) => {
    const next = digits.slice();
    next[i] = d;
    onChange(next.join('').slice(0, length));
  };

  const fill = (raw: string, from: number) => {
    const clean = raw.replace(/\D/g, '');
    if (!clean) return;
    const next = digits.slice();
    for (let k = 0; k < clean.length && from + k < length; k++) next[from + k] = clean[k]!;
    onChange(next.join(''));
    focus(Math.min(from + clean.length, length - 1));
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i]) {
      e.preventDefault();
      setAt(i - 1, '');
      focus(i - 1);
    } else if (e.key === 'ArrowLeft') focus(i - 1);
    else if (e.key === 'ArrowRight') focus(i + 1);
  };

  return (
    <div role="group" aria-label={label} className={cn('flex gap-2.5', className)}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          aria-label={`${label} digit ${i + 1}`}
          aria-invalid={error || undefined}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={length}
          autoFocus={autoFocus && i === 0}
          disabled={disabled}
          value={d}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
            e.preventDefault();
            fill(e.clipboardData.getData('text'), i);
          }}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, '');
            if (raw.length > 1) fill(raw, i); // SMS autofill / typing over a digit
            else {
              setAt(i, raw);
              if (raw) focus(i + 1);
            }
          }}
          className={cn(
            'h-[60px] w-full min-w-0 flex-1 rounded-lg border text-center text-heading-24 text-text-primary caret-brand-600 outline-none',
            'focus:border-brand-600 focus:bg-surface-card focus:shadow-[inset_0_0_0_1px_var(--color-brand-600)] disabled:opacity-50',
            // Figma 02/M2: filled = card + border-strong; empty = surface-subtle + border-default.
            d ? 'border-border-strong bg-surface-card' : 'border-border-default bg-surface-subtle',
            error && 'border-danger bg-danger-bg/40',
            boxClassName,
          )}
        />
      ))}
    </div>
  );
}
