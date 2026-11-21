import Link from 'next/link';
import type { ThemeStore } from '../types';
import type { ModernCommerceSettings } from './schema';
import { Icon, type IconName } from './components/icon';
import { StoreLogo } from './components/store-logo';

interface FooterProps {
  store: ThemeStore;
  settings: ModernCommerceSettings;
  description: string | null;
}

const HELP_LINKS = [
  { label: 'Track your order', href: '/track-order' },
  { label: 'Delivery & COD', href: '/pages/delivery' },
  { label: 'Returns & exchange', href: '/pages/returns' },
  { label: 'Contact us', href: '/pages/contact' },
];

const STORE_LINKS = [
  { label: 'Our story', href: '/pages/about' },
  { label: 'Journal', href: '/blog' },
];

const SOCIAL: Array<{ key: 'facebook' | 'instagram' | 'youtube'; label: string; icon: IconName }> = [
  { key: 'facebook', label: 'Facebook', icon: 'facebook' },
  { key: 'instagram', label: 'Instagram', icon: 'instagram' },
  { key: 'youtube', label: 'YouTube', icon: 'youtube' },
];

function Column({ title, links }: { title: string; links: Array<{ label: string; href: string }> }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3.5">
      <h2 className="type-h3">{title}</h2>
      <ul className="flex flex-col gap-3.5">
        {links.map((l) => (
          <li key={`${l.href}-${l.label}`}>
            <Link href={l.href} className="type-body-m opacity-75 hover:underline hover:opacity-100">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Figma "Site Footer/Desktop" (1:10700) / "Site Footer/Mobile" (1:10765). */
export function Footer({ store, settings, description }: FooterProps) {
  const tagline = settings.footerTagline ?? description;
  const socials = SOCIAL.filter((s) => settings.social[s.key]);
  const year = new Date().getFullYear();

  return (
    <footer className="bg-inverse text-paper">
      <div className="flex flex-col gap-10 px-4 pt-12 pb-8 lg:gap-14 lg:px-20 lg:pt-20">
        <div className="flex flex-col gap-10 lg:flex-row lg:gap-12">
          <div className="flex flex-col items-start gap-5 lg:w-[360px] lg:shrink-0">
            <StoreLogo store={store} onDark />
            {tagline ? <p className="type-body-m opacity-80">{tagline}</p> : null}
            {socials.length > 0 ? (
              <ul className="flex items-center gap-3">
                {socials.map((s) => (
                  <li key={s.key}>
                    <a
                      href={settings.social[s.key]}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      aria-label={s.label}
                      className="flex size-11 items-center justify-center rounded-full border border-paper hover:bg-paper/10"
                    >
                      <Icon name={s.icon} />
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-8 lg:flex lg:flex-1 lg:gap-12">
            <Column title="Shop" links={settings.navigation} />
            <Column title="Help" links={HELP_LINKS} />
            <Column title={store.name} links={STORE_LINKS} />
            {settings.paymentMethods.length > 0 ? (
              <div className="flex min-w-0 flex-1 flex-col gap-3.5">
                <h2 className="type-h3">Pay with</h2>
                <ul className="flex flex-wrap gap-2">
                  {settings.paymentMethods.map((m) => (
                    <li key={m} className="type-label-s rounded-sf-sm bg-surface px-2.5 py-1.5 text-ink">
                      {m}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>

        <div className="type-body-s flex flex-col gap-3 border-t border-line pt-6 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
          <p className="opacity-65">
            © {year} {store.name}
          </p>
          <p className="flex gap-1 opacity-65">
            <Link href="/pages/privacy" className="hover:underline">Privacy</Link>·
            <Link href="/pages/terms" className="hover:underline">Terms</Link>·
            <Link href="/pages/refunds" className="hover:underline">Refund policy</Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
