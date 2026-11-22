'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { StorefrontNavItem } from '@storeplix/types';
import { Icon } from './icon';

/** Window event that opens the drawer (fired by the phone tab bar's "Categories" item). */
export const OPEN_MENU_EVENT = 'sp:open-menu';

/** Same external-link rule as NavLink (kept local: client components must stay dependency-light). */
const external = (href: string) => /^https?:\/\//i.test(href);

function DrawerLink({ href, className, children, onNavigate }: { href: string; className: string; children: React.ReactNode; onNavigate: () => void }) {
  return external(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={onNavigate}>
      {children}
    </a>
  ) : (
    <a href={href} className={className} onClick={onNavigate}>
      {children}
    </a>
  );
}

/**
 * Figma "Drawer" (1:14585): main menu with expandable children, track order and WhatsApp help.
 * Only shown below the `lg` breakpoint. Items are server-validated menu data (no secrets).
 */
export function MobileMenu({
  storeName,
  items,
  trackOrderHref,
  whatsappHref,
}: {
  storeName: string;
  items: StorefrontNavItem[];
  trackOrderHref: string;
  whatsappHref: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const openMenu = () => setOpen(true);
    window.addEventListener(OPEN_MENU_EVENT, openMenu);
    return () => window.removeEventListener(OPEN_MENU_EVENT, openMenu);
  }, []);

  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        aria-label="Menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex size-11 items-center justify-center rounded-full bg-sunken text-ink lg:hidden"
      >
        <Icon name="menu" />
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onClose={close}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        className="m-0 h-dvh max-h-none w-[340px] max-w-[88vw] bg-surface p-0 text-[#0e1a33] backdrop:bg-[#0e1a33]/40 lg:hidden"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between px-4 py-3.5">
            <p id={titleId} className="truncate font-heading text-[22px] font-semibold text-brand">
              {storeName}
            </p>
            <button type="button" aria-label="Close menu" onClick={close} className="flex size-10 items-center justify-center">
              <Icon name="x" />
            </button>
          </div>
          <a href="/account" onClick={close} className="flex items-center gap-3 bg-brand-soft px-4 py-3.5">
            <Icon name="user" className="text-brand" />
            <span className="flex flex-col">
              <span className="type-label-m text-brand">Sign in or join</span>
              <span className="type-body-s text-[#33405c]">Track orders, save your wishlist</span>
            </span>
          </a>
          <nav aria-label="Main menu" className="flex-1 overflow-y-auto px-4 py-2">
            <ul>
              {items.map((item) => {
                const isOpen = expanded === item.id;
                return (
                  <li key={item.id} className="border-b border-line-subtle">
                    {item.children.length > 0 ? (
                      <>
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(isOpen ? null : item.id)}
                          className={`type-label-m flex w-full items-center gap-3 py-3.5 text-left ${isOpen ? 'text-brand' : ''}`}
                        >
                          <span className="flex-1">{item.label}</span>
                          <Icon name={isOpen ? 'minus' : 'plus'} className="text-[#66728c]" />
                        </button>
                        {isOpen ? (
                          <ul className="type-body-m flex flex-col gap-2.5 pt-1 pb-3 pl-8 text-[#33405c]">
                            {item.children.map((c) => (
                              <li key={c.id}>
                                <DrawerLink href={c.href} className="hover:text-brand" onNavigate={close}>
                                  {c.label}
                                </DrawerLink>
                              </li>
                            ))}
                            <li>
                              <DrawerLink href={item.href} className="hover:text-brand" onNavigate={close}>
                                View all {item.label.toLowerCase()}
                              </DrawerLink>
                            </li>
                          </ul>
                        ) : null}
                      </>
                    ) : (
                      <DrawerLink href={item.href} className="type-label-m flex py-3.5 hover:text-brand" onNavigate={close}>
                        {item.label}
                      </DrawerLink>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="type-label-s flex flex-col gap-3 p-4">
            <a href={trackOrderHref} onClick={close} className="flex items-center gap-2.5">
              <Icon name="truck-sm" className="text-brand" />
              Track order
            </a>
            {whatsappHref ? (
              <a href={whatsappHref} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5">
                <Icon name="whatsapp" className="text-brand" />
                Help on WhatsApp
              </a>
            ) : null}
          </div>
        </div>
      </dialog>
    </>
  );
}
