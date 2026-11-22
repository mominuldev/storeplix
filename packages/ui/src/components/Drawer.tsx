import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

// Side sheet (Foundations 128:221 Overlay: Elevation/1 + 40% ink scrim). Used on narrow screens for the editor's
// section list / settings panels. Uses <dialog> for focus trapping and Escape.
export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  side?: 'left' | 'right' | 'bottom';
  children: ReactNode;
  /** Sticky footer (e.g. Delete / Cancel / Save, Categories 60:9780 side panel). */
  footer?: ReactNode;
  description?: ReactNode;
  /** Panel width for left/right drawers (default 360). */
  width?: number;
  className?: string;
}

const placement = {
  left: 'mr-auto ml-0 h-dvh max-h-dvh w-[min(360px,100%-48px)]',
  right: 'ml-auto mr-0 h-dvh max-h-dvh w-[min(360px,100%-48px)]',
  bottom: 'mt-auto mb-0 max-h-[85dvh] w-full max-w-full rounded-t-card',
} as const;

export function Drawer({ open, onClose, title, side = 'right', children, footer, description, width, className }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

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
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      style={width && side !== 'bottom' ? { width: `min(${width}px, 100% - 24px)` } : undefined}
      className={cn(
        'flex flex-col overflow-hidden border border-border-default bg-surface-card p-0 text-text-primary shadow-elevation-1 backdrop:bg-text-primary/40',
        placement[side],
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-border-default px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id={titleId} className="truncate text-body-lg font-semibold">
            {title}
          </h2>
          {description && <p className="truncate text-caption text-text-muted">{description}</p>}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1.5 text-text-muted outline-none hover:bg-surface-subtle focus-visible:shadow-focus">
          <X aria-hidden className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer && <div className="flex items-center gap-2 border-t border-border-default px-4 py-3">{footer}</div>}
    </dialog>
  );
}
