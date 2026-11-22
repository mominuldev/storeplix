import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

// Integrations · Connect wizard 32:4105: two panes, radius 20 (card), elevation-1 on a 40% ink scrim. Left rail 280px
// surface-canvas p 28 (logo, title, step list, help note); right pane p 28/32. Under md the rail stacks on top.
// Same <dialog> behaviour as Modal (focus trap, Escape, top layer).
export interface WizardModalProps {
  open: boolean;
  onClose: () => void;
  /** id of the heading inside `children` that names the dialog. */
  labelledBy: string;
  aside: ReactNode;
  children: ReactNode;
  className?: string;
}

export function WizardModal({ open, onClose, labelledBy, aside, children, className }: WizardModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cn(
        'm-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[800px] overflow-y-auto rounded-card border border-border-default bg-surface-card p-0 text-text-primary shadow-elevation-1 backdrop:bg-text-primary/40',
        className,
      )}
    >
      <div className="flex flex-col md:flex-row">
        <aside className="flex flex-col gap-5 border-b border-border-default bg-surface-canvas p-5 md:w-[280px] md:shrink-0 md:border-r md:border-b-0 md:p-7">{aside}</aside>
        <div className="relative flex min-w-0 flex-1 flex-col gap-[18px] p-5 md:px-8 md:py-7">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute top-5 right-5 flex size-8 items-center justify-center rounded-md bg-surface-subtle text-text-secondary outline-none hover:text-text-primary focus-visible:shadow-focus md:top-7 md:right-8"
          >
            <X aria-hidden className="size-4" />
          </button>
          {children}
        </div>
      </div>
    </dialog>
  );
}
