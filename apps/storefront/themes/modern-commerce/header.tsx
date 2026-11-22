import Link from 'next/link';
import type { StoreContact, StorefrontNavItem, StorefrontNavMenu } from '@storeplix/types';
import type { ThemeStore } from '../types';
import type { ModernCommerceSettings } from './schema';
import { Icon } from './components/icon';
import { MobileMenu } from './components/mobile-menu';
import { NavLink } from './components/nav-link';
import { StoreLogo } from './components/store-logo';
import { CartBadgeButton } from './commerce/cart-badge';
import { telHref, whatsappHref } from '@/lib/contact';

interface HeaderProps {
  store: ThemeStore;
  settings: ModernCommerceSettings;
  contact: StoreContact;
  menu: StorefrontNavMenu;
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
export function Header({ store, settings, contact, menu }: HeaderProps) {
  const tel = telHref(contact.phone);
  const wa = whatsappHref(contact.whatsapp);
  const { announcement, header } = settings;

  return (
    <header className={header.sticky ? 'sticky top-0 z-40' : undefined}>
      {announcement.enabled && announcement.text ? (
        <div className="type-label-s bg-inverse text-paper">
          <div className="flex items-center justify-center gap-1.5 px-4 py-2 md:px-10 md:py-2.5 lg:justify-between lg:px-20">
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
            <p className="flex items-center gap-1.5 text-center md:gap-2">
              <Icon name="sparkle" className="text-accent max-md:size-3.5" />
              {announcement.href ? (
                <NavLink href={announcement.href} className="hover:underline">
                  {announcement.text}
                </NavLink>
              ) : (
                announcement.text
              )}
            </p>
            <div className="hidden items-center gap-3 lg:flex">
              <Link href="/track" className="hover:underline">
                Track order
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      <div className="bg-canvas md:border-b md:border-line-subtle">
        <div className="flex flex-col gap-3 px-4 pt-3 pb-4 md:gap-4 md:px-10 md:py-4 lg:flex-row lg:items-center lg:gap-10 lg:px-20 lg:py-5">
          <div className="flex items-center justify-between gap-2 lg:contents">
            <div className="flex items-center gap-1 md:gap-2 lg:contents">
              <MobileMenu
                storeName={store.name}
                items={menu.items}
                trackOrderHref="/track"
                whatsappHref={wa}
              />
              <Link href="/" className="shrink-0" aria-label={`${store.name} home`}>
                <span className="md:hidden">
                  <StoreLogo store={store} size="sm" />
                </span>
                <span className="hidden md:inline">
                  <StoreLogo store={store} />
                </span>
              </Link>
            </div>
            <div className="lg:hidden">
              <CartBadgeButton />
            </div>
          </div>

          {header.showSearch ? (
            <SearchField id="site-search" placeholder="Search the store…" className="w-full lg:min-w-0 lg:flex-1" />
          ) : (
            <span className="hidden lg:block lg:flex-1" />
          )}

          {menu.items.length > 0 ? (
            /* Tablet 1:10799: top-level links in one scrolling row under the search. */
            <nav aria-label={menu.title} className="-mx-10 hidden gap-6 overflow-x-auto px-10 md:flex lg:hidden [scrollbar-width:none]">
              {menu.items.map((item) => (
                <NavLink key={item.id} href={item.href} className="type-label-m shrink-0 whitespace-nowrap text-ink hover:text-brand">
                  {item.label}
                </NavLink>
              ))}
            </nav>
          ) : null}

          <div className="hidden shrink-0 items-center gap-2 lg:flex">
            {/* Account and wishlist are deferred (PHASE-5-CONTRACT §11): hidden, never faked. */}
            <CartBadgeButton />
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
