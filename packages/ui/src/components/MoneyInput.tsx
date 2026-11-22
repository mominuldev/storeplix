import { useEffect, useRef, useState } from 'react';
import { moneyToInput, parseMoney } from '../lib/money';
import { Input, type InputProps } from './Input';

// Product editor 60:9381 price fields — "৳ 3,450": Input with a ৳ leading adornment. `value` is paisa;
// `onChange` receives paisa, `null` (empty) or `NaN` (not a valid amount; schemas turn that into a message).
export interface MoneyInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'leading' | 'defaultValue'> {
  value: number | null | undefined;
  onChange: (paisa: number | null) => void;
}

export function MoneyInput({ value, onChange, onBlur, fieldClassName, ...props }: MoneyInputProps) {
  const [text, setText] = useState(() => moneyToInput(value));
  const lastEmitted = useRef<number | null | undefined>(value);

  // External value changes (reset, server data) replace the text; our own echoes don't.
  useEffect(() => {
    if (!Object.is(value ?? null, lastEmitted.current ?? null)) {
      lastEmitted.current = value;
      setText(moneyToInput(value));
    }
  }, [value]);

  return (
    <Input
      {...props}
      inputMode="decimal"
      autoComplete="off"
      value={text}
      leading={<span className="font-bangla text-body text-text-muted">৳</span>}
      fieldClassName={fieldClassName}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const paisa = parseMoney(next);
        lastEmitted.current = paisa;
        onChange(paisa);
      }}
      onBlur={(e) => {
        const paisa = parseMoney(text);
        if (paisa !== null && Number.isFinite(paisa)) setText(moneyToInput(paisa));
        onBlur?.(e);
      }}
    />
  );
}
