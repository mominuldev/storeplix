import Link from 'next/link';
import type { ThemeStore } from '../types';
import type { ModernCommerceSettings } from './schema';
import { Icon } from './components/icon';
import { StoreLogo } from './components/store-logo';

interface HeaderProps {
  store: ThemeStore;
  settings: ModernCommerceSettings;
  /** From the cart API once it exists; hidden when 0. */
  cartCount?: number;
}

function SearchField({ placeholder, className = '' }: { placeholder: string; className?: string }) {
  return (
    <form
      role="search"
      action="/search"
      className={`flex h-12 items-center gap-3 rounded-full border border-line-subtle bg-sunken py-1 pr-1 pl-5 ${className}`}
    >
      <Icon name="search" className="text-ink-muted" />
      <label htmlFor="site-search" className="sr-only">
        Search
      </label>
      <input
        id="site-search"
        name="q"
        type="search"
        placeholder={placeholder}
        className="type-body-m min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-muted"
      />
      <button type="submit" className="type-label-s rounded-full bg-brand px-4 py-2 text-on-brand hover:brightness-110">
        Search
      </button>
    </form>
  );
}

function CartButton({ count }: { count: number }) {
  return (
    <Link href="/cart" aria-label={`Cart${count ? `, ${count} items` : ''}`} className="relative flex h-12 w-[52px] items-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-brand text-on-brand">
        <Icon name="bag" />
      </span>
      {count > 0 ? (
        <span className="type-label-s absolute top-0 left-8 rounded-full bg-accent px-1.5 py-px text-on-accent">{count}</span>
      ) : null}
    </Link>
  );
}

/** Figma "Site Header/Desktop" (1:10645) and "Site Header/Mobile" (1:10751). */
export function Header({ store, settings, cartCount = 0 }: HeaderProps) {
  return (
    <header>
      {/* Announcement bar */}
      <div className="type-label-s bg-inverse text-paper">
        <div className="flex items-center justify-center gap-1.5 px-4 py-2 lg:justify-between lg:px-20 lg:py-2.5">
          <p className="hidden items-center gap-2 lg:flex">
            {settings.hotline ? (
              <>
                <Icon name="phone" />
                {settings.hotline}
              </>
            ) : null}
          </p>
          <p className="flex items-center gap-1.5 lg:gap-2">
            <Icon name="sparkle" className="max-lg:size-3.5 text-accent" />
            {settings.announcement}
          </p>
          <div className="hidden items-center gap-3 lg:flex">
            <Link href="/track-order" className="hover:underline">
              Track order
            </Link>
          </div>
        </div>
      </div>

      <div className="border-b border-line-subtle bg-canvas">
        {/* Top row */}
        <div className="flex flex-col gap-3 px-4 pt-3 pb-4 lg:flex-row lg:items-center lg:gap-10 lg:px-20 lg:py-5">
          <div className="flex items-center justify-between gap-2 lg:contents">
            <div className="flex items-center gap-1 lg:contents">
              <Link
                href="/collections"
                aria-label="Menu"
                className="flex size-11 items-center justify-center rounded-full bg-sunken text-ink lg:hidden"
              >
                <Icon name="menu" />
              </Link>
              <Link href="/" className="shrink-0" aria-label={`${store.name} home`}>
                <span className="lg:hidden">
                  <StoreLogo store={store} size="sm" />
                </span>
                <span className="hidden lg:inline">
                  <StoreLogo store={store} />
                </span>
              </Link>
            </div>
            <div className="lg:hidden">
              <CartButton count={cartCount} />
            </div>
          </div>

          <SearchField placeholder="Search the store…" className="w-full lg:min-w-0 lg:flex-1" />

          <div className="hidden shrink-0 items-center gap-2 lg:flex">
            <Link href="/account" className="flex items-center gap-2 pr-3">
              <span className="flex size-11 items-center justify-center rounded-full bg-sunken text-ink">
                <Icon name="user" />
              </span>
              <span className="flex flex-col whitespace-nowrap">
                <span className="type-body-s text-ink-muted">Hello, sign in</span>
                <span className="text-[15px] leading-[1.3] font-semibold text-ink">Account</span>
              </span>
            </Link>
            <Link
              href="/wishlist"
              aria-label="Wishlist"
              className="flex size-11 items-center justify-center rounded-full bg-sunken text-ink"
            >
              <Icon name="heart" />
            </Link>
            <CartButton count={cartCount} />
          </div>
        </div>

        {/* Category nav (desktop) */}
        <nav aria-label="Categories" className="hidden items-center justify-between gap-8 px-20 pb-4 lg:flex">
          <ul className="flex items-center gap-8">
            <li>
              <Link
                href="/collections"
                className="type-label-m flex items-center gap-2 rounded-full bg-brand-soft px-4 py-2 text-brand"
              >
                <Icon name="list" />
                All categories
              </Link>
            </li>
            {settings.navigation.map((link) => (
              <li key={`${link.href}-${link.label}`}>
                <Link href={link.href} className="type-label-m whitespace-nowrap text-ink hover:text-brand">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          {settings.promoLink ? (
            <Link href={settings.promoLink.href} className="type-label-m flex items-center gap-1.5 text-sale">
              <Icon name="tag" />
              {settings.promoLink.label}
            </Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
