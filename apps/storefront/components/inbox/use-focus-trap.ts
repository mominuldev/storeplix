'use client';

import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable descendants in DOM order (exported for tests). */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true');
}

/**
 * Dialog focus handling (PHASE-8-8E §9.3): focus moves into the panel on open, Tab / Shift+Tab cycle inside it, Esc
 * closes, and focus returns to the element that opened it.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void, returnTo?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const opener = returnTo?.current ?? (document.activeElement as HTMLElement | null);
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root;
    first.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const head = items[0]!;
      const tail = items[items.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === head || !root.contains(current))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (current === tail || !root.contains(current))) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.({ preventScroll: true });
    };
  }, [ref, active, onEscape, returnTo]);
}
