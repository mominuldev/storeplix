import Link from 'next/link';
import type { ReactNode } from 'react';
import { isExternalHref } from '@/lib/sanitize';

/**
 * Link for already-sanitized hrefs (navigation, promo, announcement). External links open in a new
 * tab with rel="noopener noreferrer"; internal ones use client navigation.
 */
export function NavLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (isExternalHref(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
