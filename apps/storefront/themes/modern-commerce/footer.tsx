import type { PaymentMethodBadge, StorefrontNavMenu } from '@storeplix/types';
import type { ThemeContact, ThemeStore } from '../types';
import type { ModernCommerceSettings } from './schema';
import { ContactList, SocialLinksRow } from './components/contact';
import { NavLink } from './components/nav-link';
import { StoreLogo } from './components/store-logo';

interface FooterProps extends ThemeContact {
  store: ThemeStore;
  settings: ModernCommerceSettings;
  description: string | null;
  menus: StorefrontNavMenu[];
}

export const PAYMENT_LABELS: Record<PaymentMethodBadge, string> = {
  cod: 'Cash on delivery',
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  upay: 'Upay',
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
};

function Column({ menu }: { menu: StorefrontNavMenu }) {
  // Footer columns are flat lists: a parent's children follow it (menus are at most two levels deep).
  const links = menu.items.flatMap((i) => [i, ...i.children]);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3.5">
      <h2 className="type-h3">{menu.title}</h2>
      <ul className="flex flex-col gap-3.5">
        {links.map((l) => (
          <li key={l.id}>
            <NavLink href={l.href} className="type-body-m opacity-75 hover:underline hover:opacity-100">
              {l.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Figma "Site Footer/Desktop" (1:10700) / "Site Footer/Mobile" (1:10765). */
export function Footer({ store, settings, description, contact, social, menus }: FooterProps) {
  const tagline = settings.footer.tagline ?? description;
  const payments = settings.footer.showPaymentMethods ? settings.footer.paymentMethods : [];
  const columns = menus.filter((m) => m.items.length > 0);
  const year = new Date().getFullYear();

  return (
    <footer className="bg-inverse text-paper">
      <div className="flex flex-col gap-10 px-4 pt-12 pb-8 lg:gap-14 lg:px-20 lg:pt-20">
        <div className="flex flex-col gap-10 lg:flex-row lg:gap-12">
          <div className="flex flex-col items-start gap-5 lg:w-[360px] lg:shrink-0">
            <StoreLogo store={store} onDark />
            {tagline ? <p className="type-body-m opacity-80">{tagline}</p> : null}
            <ContactList contact={contact} />
            <SocialLinksRow social={social} />
          </div>

          <div className="grid grid-cols-2 gap-8 lg:flex lg:flex-1 lg:gap-12">
            {columns.map((m) => (
              <Column key={m.title} menu={m} />
            ))}
            {payments.length > 0 ? (
              <div className="col-span-2 flex min-w-0 flex-1 flex-col gap-3.5 lg:col-span-1">
                <h2 className="type-h3">Pay with</h2>
                <ul className="flex flex-wrap gap-2" aria-label="Payment methods">
                  {payments.map((m) => (
                    <li key={m} className="type-label-s rounded-sf-sm bg-surface px-2.5 py-1.5 text-[#0e1a33]">
                      {PAYMENT_LABELS[m]}
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
        </div>
      </div>
    </footer>
  );
}
