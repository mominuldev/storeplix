import Link from 'next/link';
import type { StoreContact, StorefrontNavItem, StorefrontNavMenu } from '@storeplix/types';
import type { ThemeStore } from '../types';
import type { ModernCommerceSettings } from './schema';
import { Icon } from './components/icon';
import { MobileMenu } from './components/mobile-menu';
import { NavLink } from './components/nav-link';
import { StoreLogo } from './components/store-logo';
import { telHref, whatsappHref } from '@/lib/contact';

interface HeaderProps {
  store: ThemeStore;
  settings: ModernCommerceSettings;
  contact: StoreContact;
  menu: StorefrontNavMenu;
  /** From the cart API once it exists; hidden when 0. */
  cartCount?: number;
}

function SearchField({ placeholder, id, className = '' }: { placeholder: string; id: string; className?: string }) {
  return (
    <form
      role="search"
      action="/search"
      className={`flex h-12 items-center gap-3 rounded-full border border-line-subtle bg-sunken py-1 pr-1 pl-5 ${className}`}
    >
      <Icon name="search" className="text-ink-muted" />
      <label htmlFor={id} className="sr-only">
        Search
      </label>
      <input
        id={id}
        name="q"
        type="search"
        placeholder={placeholder}
        className="type-body-m min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-muted"
      />
      <button type="submit" className="type-label-s rounded-control bg-brand px-4 py-2 text-on-brand hover:brightness-110">
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

/** Desktop nav item: children open as a simple dropdown on hover/focus (no JS; mega menu is out of scope). */
function DesktopNavItem({ item }: { item: StorefrontNavItem }) {
  if (item.children.length === 0) {
    return (
      <li>
        <NavLink href={item.href} className="type-label-m whitespace-nowrap text-ink hover:text-brand">
          {item.label}
        </NavLink>
      </li>
    );
  }
  return (
    <li className="group relative">
      <NavLink href={item.href} className="type-label-m flex items-center gap-1 whitespace-nowrap text-ink hover:text-brand">
        {item.label}
        <Icon name="caret-down" className="text-ink-muted" />
      </NavLink>
      <ul className="invisible absolute top-full left-0 z-30 mt-2 flex min-w-[220px] flex-col rounded-sf-lg border border-line-subtle bg-surface p-2 opacity-0 shadow-e3 transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        {item.children.map((c) => (
          <li key={c.id}>
            <NavLink href={c.href} className="type-body-m block rounded-sf-md px-3 py-2 text-[#33405c] hover:bg-sunken hover:text-[#0e1a33]">
              {c.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Figma "Site Header/Desktop" (1:10645), tablet (1:10799) and mobile (1:10751); drawer 1:14585. */
export function Header({ store, settings, contact, menu, cartCount = 0 }: HeaderProps) {
  const tel = telHref(contact.phone);
  const wa = whatsappHref(contact.whatsapp);
  const { announcement, header } = settings;

  return (
    <header className={header.sticky ? 'sticky top-0 z-40' : undefined}>
      {announcement.enabled && announcement.text ? (
        <div className="type-label-s bg-inverse text-paper">
          <div className="flex items-center justify-center gap-1.5 px-4 py-2 lg:justify-between lg:px-20 lg:py-2.5">
            <p className="hidden items-center gap-2 lg:flex">
              {tel ? (
                <a href={tel} className="flex items-center gap-2 hover:underline">
                  <Icon name="phone" />
                  Hotline {contact.phone}
                  {contact.support_hours ? ` · ${contact.support_hours}` : ''}
                </a>
              ) : contact.support_hours ? (
                <span>{contact.support_hours}</span>
              ) : null}
            </p>
            <p className="flex items-center gap-1.5 text-center lg:gap-2">
              <Icon name="sparkle" className="text-accent max-lg:size-3.5" />
              {announcement.href ? (
                <NavLink href={announcement.href} className="hover:underline">
                  {announcement.text}
                </NavLink>
              ) : (
                announcement.text
              )}
            </p>
            <div className="hidden items-center gap-3 lg:flex">
              <Link href="/track-order" className="hover:underline">
                Track order
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      <div className="border-b border-line-subtle bg-canvas">
        <div className="flex flex-col gap-3 px-4 pt-3 pb-4 lg:flex-row lg:items-center lg:gap-10 lg:px-20 lg:py-5">
          <div className="flex items-center justify-between gap-2 lg:contents">
            <div className="flex items-center gap-1 lg:contents">
              <MobileMenu
                storeName={store.name}
                items={menu.items}
                trackOrderHref="/track-order"
                whatsappHref={wa}
              />
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

          {header.showSearch ? (
            <SearchField id="site-search" placeholder="Search the store…" className="w-full lg:min-w-0 lg:flex-1" />
          ) : (
            <span className="hidden lg:block lg:flex-1" />
          )}

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
            <Link href="/wishlist" aria-label="Wishlist" className="flex size-11 items-center justify-center rounded-full bg-sunken text-ink">
              <Icon name="heart" />
            </Link>
            <CartButton count={cartCount} />
          </div>
        </div>

        {menu.items.length > 0 || header.promoLink ? (
          <nav aria-label={menu.title} className="hidden items-center justify-between gap-8 px-20 pb-4 lg:flex">
            <ul className="flex items-center gap-8">
              {menu.items.map((item) => (
                <DesktopNavItem key={item.id} item={item} />
              ))}
            </ul>
            {header.promoLink ? (
              <NavLink href={header.promoLink.href} className="type-label-m flex items-center gap-1.5 text-sale">
                <Icon name="tag" />
                {header.promoLink.label}
              </NavLink>
            ) : null}
          </nav>
        ) : null}
      </div>
    </header>
  );
}
