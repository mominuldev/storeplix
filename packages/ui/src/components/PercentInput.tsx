import { useEffect, useRef, useState } from 'react';
import { bpsToInput, parsePercent } from '../lib/percent';
import { Input, type InputProps } from './Input';

export interface PercentInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'trailing' | 'defaultValue'> {
  value: number | null | undefined;
  onChange: (bps: number | null) => void;
}

export function PercentInput({ value, onChange, ...props }: PercentInputProps) {
  const [text, setText] = useState(() => bpsToInput(value));
  const last = useRef<number | null | undefined>(value);
  useEffect(() => {
    if (!Object.is(value ?? null, last.current ?? null)) {
      last.current = value;
      setText(bpsToInput(value));
    }
  }, [value]);
  return (
    <Input
      {...props}
      inputMode="decimal"
      autoComplete="off"
      value={text}
      trailing={<span className="text-body text-text-muted">%</span>}
      onChange={(e) => {
        setText(e.target.value);
        const bps = parsePercent(e.target.value);
        last.current = bps;
        onChange(bps);
      }}
    />
  );
}
