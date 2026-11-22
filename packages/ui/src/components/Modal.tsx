import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

// Foundations 128:221 Overlay — "Menus and dialogs: Elevation/1 plus a 40% ink scrim". Uses <dialog> for
// focus trapping, Escape and top-layer stacking.
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Left side of the footer (e.g. a destructive "Delete" link). */
  footerStart?: ReactNode;
  /** sm 440 · md 520 (default) · lg 640 · xl 760. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const sizes = { sm: 'max-w-[440px]', md: 'max-w-[520px]', lg: 'max-w-[640px]', xl: 'max-w-[760px]' } as const;

export function Modal({ open, onClose, title, description, children, footer, footerStart, size = 'md', className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

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
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cn(
        'm-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] overflow-y-auto rounded-card border border-border-default bg-surface-card p-0 text-text-primary shadow-elevation-1 backdrop:bg-text-primary/40',
        sizes[size],
        className,
      )}
    >
      <div className="flex items-start gap-4 px-6 pt-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={titleId} className="text-heading text-text-primary">
            {title}
          </h2>
          {description && (
            <p id={descId} className="text-body text-text-secondary">
              {description}
            </p>
          )}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1.5 text-text-muted outline-none hover:bg-surface-subtle focus-visible:shadow-focus">
          <X aria-hidden className="size-5" />
        </button>
      </div>
      <div className="px-6 py-5">{children}</div>
      {(footer || footerStart) && (
        <div className="flex items-center justify-end gap-3 border-t border-border-default px-6 py-4">
          {footerStart && <div className="mr-auto">{footerStart}</div>}
          {footer}
        </div>
      )}
    </dialog>
  );
}
