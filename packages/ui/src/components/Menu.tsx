import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma V3 block actions dropdown 2057:51109 — card, radius 12, Elevation/1, 14px rows with a 28px icon tile,
// optional hint line and shortcut chip; danger rows in danger colour; separators between groups.
export type MenuEntry =
  | {
      kind?: 'item';
      key: string;
      label: ReactNode;
      hint?: ReactNode;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator'; key: string };

export interface MenuProps {
  /** Accessible name of the trigger button. */
  label: string;
  trigger: ReactNode;
  entries: MenuEntry[];
  header?: ReactNode;
  align?: 'start' | 'end';
  triggerClassName?: string;
  className?: string;
  disabled?: boolean;
}

export function Menu({ label, trigger, entries, header, align = 'end', triggerClassName, className, disabled }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    listRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
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
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex size-6 items-center justify-center rounded-sm text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus disabled:opacity-40',
          open && 'bg-brand-100 text-brand-700',
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className={cn(
            'absolute top-full z-50 mt-1 flex w-[260px] flex-col rounded-lg border border-border-default bg-surface-card py-1.5 shadow-elevation-1',
            align === 'end' ? 'right-0' : 'left-0',
            className,
          )}
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
                {entry.shortcut && (
                  <kbd className="rounded-sm bg-surface-subtle px-1.5 py-0.5 font-sans text-[11px] text-text-muted">{entry.shortcut}</kbd>
                )}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
