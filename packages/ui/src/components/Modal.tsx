import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

// Foundations 128:221 Overlay — "Menus and dialogs: Elevation/1 plus a 40% ink scrim". Uses <dialog> for
// focus trapping, Escape and top-layer stacking.
//  · default — Modal / Invite staff 90:26879: radius 16, Elevation/1; header pt 24 px 24 pb 8 (Heading/20 + Body/14
//    secondary, gap 4) with a 32px bordered close button; body px 24 pt 16 pb 24; footer px 24 py 16, border-t.
//  · `icon` — Modal · Cancel order 41:9952: header pt 22 pb 18 pl 24 pr 20, gap 14, 44px tile (radius 12), plain 36px
//    close, 1px divider under the header; body px 24 py 20.
//  · variant="v3" — Online store dialogs (New page 2046:49298, Media picker 2053:51939): radius 20, shadow-dialog;
//    header pt 22 pb 18 pl 28 pr 20 with a divider, title 20/28 tracking -0.16, description 13/18 muted (gap 2),
//    plain 20px close; body unpadded (split panes); footer pl 28 pr 20 py 14, gap 10.
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
  /** Header icon, rendered in a 44px tile (Cancel order 41:9954). Pass the icon only; tint with `iconClassName`. */
  icon?: ReactNode;
  /** Tile colours for `icon` (default danger). */
  iconClassName?: string;
  variant?: 'default' | 'v3';
  className?: string;
}

const sizes = { sm: 'max-w-[440px]', md: 'max-w-[520px]', lg: 'max-w-[640px]', xl: 'max-w-[760px]' } as const;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  footerStart,
  size = 'md',
  icon,
  iconClassName = 'bg-danger-bg text-danger',
  variant = 'default',
  className,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const v3 = variant === 'v3';
  const divided = v3 || !!icon;

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
        'm-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] overflow-y-auto border border-border-default bg-surface-card p-0 text-text-primary backdrop:bg-text-primary/40',
        v3 ? 'rounded-dialog shadow-dialog' : 'rounded-card shadow-elevation-1',
        sizes[size],
        className,
      )}
    >
      <div
        className={cn(
          'flex',
          v3
            ? 'items-center gap-3 border-b border-border-default pt-[22px] pr-5 pb-[18px] pl-7'
            : icon
              ? 'items-start gap-3.5 border-b border-border-default pt-[22px] pr-5 pb-[18px] pl-6'
              : 'items-start gap-3 px-6 pt-6 pb-2',
        )}
      >
        {icon && !v3 && (
          <span aria-hidden className={cn('flex size-11 shrink-0 items-center justify-center rounded-lg [&_svg]:size-[22px]', iconClassName)}>
            {icon}
          </span>
        )}
        <div className={cn('flex min-w-0 flex-1 flex-col', v3 ? 'gap-0.5' : 'gap-1')}>
          <h2 id={titleId} className={cn('text-heading text-text-primary', v3 && 'tracking-[-0.16px]')}>
            {title}
          </h2>
          {description && (
            <p id={descId} className={v3 ? 'text-[13px] leading-[18px] text-text-muted' : 'text-body text-text-secondary'}>
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className={cn(
            'flex shrink-0 items-center justify-center text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus',
            divided ? 'size-9 rounded-control' : 'size-8 rounded-md border border-border-default bg-surface-card',
            // V3 draws a bare 20px glyph; keep a 32px hit area without shifting it.
            v3 && '-m-1.5 size-8 text-text-muted',
          )}
        >
          <X aria-hidden className={divided ? 'size-5' : 'size-4'} />
        </button>
      </div>
      <div className={v3 ? undefined : divided ? 'px-6 py-5' : 'px-6 pt-4 pb-6'}>{children}</div>
      {(footer || footerStart) && (
        <div className={cn('flex items-center justify-end border-t border-border-default', v3 ? 'gap-2.5 py-3.5 pr-5 pl-7' : 'gap-3 px-6 py-4')}>
          {footerStart && <div className="mr-auto">{footerStart}</div>}
          {footer}
        </div>
      )}
    </dialog>
  );
}
