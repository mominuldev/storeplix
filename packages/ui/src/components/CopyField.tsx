import { Check, Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { cn } from '../lib/cn';
import { Label } from './Label';

// Read-only value with a Copy button (payment link URL, webhook URL). Field styling from Input 3:58.
export interface CopyFieldProps {
  value: string;
  label?: string;
  className?: string;
  /** Called after a successful copy (e.g. to toast). */
  onCopied?: () => void;
}

export function CopyField({ value, label, className, onCopied }: CopyFieldProps) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      <div className="flex min-h-11 items-center gap-2 rounded-md border border-border-default bg-surface-subtle pl-3">
        <input id={id} readOnly value={value} onFocus={(e) => e.target.select()} className="w-full min-w-0 truncate bg-transparent py-2 text-body text-text-primary outline-none" />
        <button
          type="button"
          onClick={async () => {
            if (await copyText(value)) {
              setCopied(true);
              onCopied?.();
              setTimeout(() => setCopied(false), 1500);
            }
          }}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-r-md border-l border-border-default px-3 text-body font-medium text-brand-600 outline-none hover:bg-surface-card focus-visible:shadow-focus"
        >
          {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
