import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { cn } from '../lib/cn';

// Figma V3 Domains DNS value cell 2042:48139: card chip (border, radius 6, px 8 py 3, Caption/12 Medium) followed by
// a 15px copy icon in brand colour. Long values (TXT tokens) wrap inside the chip instead of scrolling the page.
export interface CopyValueProps {
  value: string;
  /** Accessible name for the copy button, e.g. "Copy TXT value". */
  label?: string;
  className?: string;
  onCopied?: () => void;
}

export function CopyValue({ value, label, className, onCopied }: CopyValueProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <code className="min-w-0 rounded-sm border border-border-default bg-surface-card px-2 py-[3px] font-sans text-caption font-medium break-all text-text-primary">{value}</code>
      <button
        type="button"
        aria-label={copied ? 'Copied' : (label ?? `Copy ${value}`)}
        title={copied ? 'Copied' : 'Copy'}
        onClick={async () => {
          if (await copyText(value)) {
            setCopied(true);
            onCopied?.();
          }
        }}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-brand-600 outline-none hover:bg-brand-50 focus-visible:shadow-focus"
      >
        {copied ? <Check aria-hidden className="size-[15px]" /> : <Copy aria-hidden className="size-[15px]" />}
      </button>
    </span>
  );
}
