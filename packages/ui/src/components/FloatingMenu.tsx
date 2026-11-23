import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';
import type { MenuProps } from './Menu';

const MENU_WIDTH = 260;
const GAP = 4;

/**
 * Same look and entries as `Menu` (Figma V3 block actions dropdown 2057:51109), but the list renders in a portal with
 * fixed positioning, so it is never clipped by a scrolling or `overflow-hidden` table (row menus on the last rows).
 * Opens below the trigger, or above it when there isn't room; closes on outside click, Escape, Tab, scroll and resize.
 */
export function FloatingMenu({ label, trigger, entries, header, align = 'end', triggerClassName, className, disabled }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const height = listRef.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(align === 'end' ? r.right - MENU_WIDTH : r.left, window.innerWidth - MENU_WIDTH - 8));
    const roomBelow = window.innerHeight - r.bottom;
    setPos(height && roomBelow < height + GAP && r.top > roomBelow ? { bottom: window.innerHeight - r.top + GAP, left } : { top: r.bottom + GAP, left });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!listRef.current?.contains(t) && !triggerRef.current?.contains(t)) close();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    listRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={cn(
          'inline-flex size-6 items-center justify-center rounded-sm text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus disabled:opacity-40',
          open && 'bg-brand-100 text-brand-700',
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'fixed', width: MENU_WIDTH, ...(pos ?? { top: -9999, left: -9999 }) }}
            className={cn('z-50 flex flex-col rounded-lg border border-border-default bg-surface-card py-1.5 text-left shadow-elevation-1', className)}
          >
            {header && <div className="border-b border-border-default px-3 pt-1.5 pb-2.5">{header}</div>}
            {entries.map((entry) =>
              entry.kind === 'separator' ? (
                <div key={entry.key} role="separator" className="my-1.5 h-px bg-border-default" />
              ) : (
                <button
                  key={entry.key}
                  type="button"
                  role="menuitem"
                  disabled={entry.disabled}
                  onClick={() => {
                    setOpen(false);
                    entry.onSelect();
                  }}
                  className={cn(
                    'mx-1.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-subtle focus-visible:bg-surface-subtle disabled:opacity-40',
                    entry.danger ? 'text-danger' : 'text-text-primary',
                  )}
                >
                  {entry.icon && (
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-4',
                        entry.danger ? 'bg-danger-bg text-danger' : 'bg-surface-subtle text-text-secondary',
                      )}
                    >
                      {entry.icon}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-body font-medium">{entry.label}</span>
                    {entry.hint && <span className="text-caption text-text-muted">{entry.hint}</span>}
                  </span>
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
