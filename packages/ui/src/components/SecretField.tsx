import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { Input, type InputProps } from './Input';

// Connect wizard 32:3770 secret fields ("App secret" masked). Write-only: the value is never pre-filled from the
// server. When a secret is already saved, `savedHint` (e.g. "••••3f9a") shows as the placeholder so the merchant knows
// one exists; typing replaces it. The show/hide toggle only reveals what the merchant typed in this session.
export interface SecretFieldProps extends Omit<InputProps, 'type' | 'trailing' | 'value' | 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  savedHint?: string | null;
}

export function SecretField({ value, onChange, savedHint, placeholder, label, ...props }: SecretFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      {...props}
      label={label}
      type={shown ? 'text' : 'password'}
      autoComplete="new-password"
      spellCheck={false}
      value={value}
      placeholder={savedHint ? `Saved ${savedHint} · type to replace` : placeholder}
      onChange={(e) => onChange(e.target.value)}
      trailing={
        <button
          type="button"
          aria-label={shown ? `Hide ${label ?? 'secret'}` : `Show ${label ?? 'secret'}`}
          aria-pressed={shown}
          disabled={!value}
          onClick={() => setShown((s) => !s)}
          className="rounded-sm text-text-muted outline-none hover:text-text-primary focus-visible:shadow-focus disabled:opacity-40"
        >
          {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        </button>
      }
    />
  );
}
