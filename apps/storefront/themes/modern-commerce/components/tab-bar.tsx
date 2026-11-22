'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icon';
import { OPEN_MENU_EVENT } from './mobile-menu';

const ITEM = 'type-label-s flex flex-col items-center gap-1 px-2 py-1';

/**
 * Figma "Tab Bar" (1:10782) on the phone home page (1:10335): sticky, rounded top, e3 shadow; the
 * active item is brand. Wishlist and Account are deferred (PHASE-5-CONTRACT §5), so they are left
 * out rather than faked. "Categories" opens the menu drawer. The spacer keeps the footer clear.
 */
export function MobileTabBar() {
  const pathname = usePathname();
  if (pathname !== '/') return null;
  return (
    <>
      <div aria-hidden className="h-[88px] bg-inverse md:hidden" />
      <nav
        aria-label="Shortcuts"
        className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around rounded-t-[22px] bg-surface px-2 pt-2.5 pb-[max(24px,env(safe-area-inset-bottom))] shadow-e3 md:hidden"
      >
        <Link href="/" aria-current="page" className={`${ITEM} text-brand`}>
          <Icon name="package" />
          Home
        </Link>
        <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_MENU_EVENT))} className={`${ITEM} text-ink-muted`}>
          <Icon name="list-lg" />
          Categories
        </button>
        <Link href="/search" className={`${ITEM} text-ink-muted`}>
          <Icon name="search-lg" />
          Search
        </Link>
      </nav>
    </>
  );
}
