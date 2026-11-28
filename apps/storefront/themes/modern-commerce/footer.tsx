import type { ReactNode } from 'react';
import type { PaymentMethod, PaymentMethodBadge, StorefrontNavMenu } from '@storeplix/types';
import type { ThemeContact, ThemeStore } from '../types';
import type { ModernCommerceSettings } from './schema';
import { ContactList, SocialLinksRow, contactItems, socialItems } from './components/contact';
import { Icon } from './components/icon';
import { NavLink } from './components/nav-link';
import { isOfferedMethod } from '@/lib/payments';
import { StoreLogo } from './components/store-logo';

interface FooterProps extends ThemeContact {
  store: ThemeStore;
  settings: ModernCommerceSettings;
  description: string | null;
  menus: StorefrontNavMenu[];
  /** Enabled checkout methods (`config.commerce.payment_methods`); null = not sent (older API). */
  paymentMethods?: PaymentMethod[] | null;
}

/** Checkout method → footer badge. */
export const CHECKOUT_METHOD_BADGES: Record<PaymentMethod, PaymentMethodBadge[]> = { cod: ['cod'], bkash: ['bkash'], sslcommerz: ['visa', 'mastercard'], nagad: ['nagad'] };

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

/** Figma "Site Footer/Mobile" (1:10765) accordion row: Label/M title, plus icon, border/default rule. */
function Accordion({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group border-t border-line">
      <summary className="type-label-m flex cursor-pointer list-none items-center justify-between py-4 [&::-webkit-details-marker]:hidden">
        {title}
        <Icon name="plus" size={18} className="transition group-open:rotate-45" />
      </summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}

function PaymentBadges({ payments }: { payments: PaymentMethodBadge[] }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Payment methods">
      {payments.map((m) => (
        <li key={m} className="type-label-s rounded-sf-sm bg-surface px-2.5 py-1.5 text-[#0e1a33]">
          {PAYMENT_LABELS[m]}
        </li>
      ))}
    </ul>
  );
}

/** Figma "Site Footer/Desktop" (1:10700) / "Site Footer/Mobile" (1:10765). */
export function Footer({ store, settings, description, contact, social, menus, paymentMethods = null }: FooterProps) {
  const tagline = settings.footer.tagline ?? description;
  // "Pay with" shows what checkout really accepts once the API sends it (PHASE-5-CONTRACT §5).
  const accepted = paymentMethods ? paymentMethods.filter(isOfferedMethod).flatMap((m) => CHECKOUT_METHOD_BADGES[m] ?? []) : settings.footer.paymentMethods;
  const payments = settings.footer.showPaymentMethods ? accepted : [];
  const columns = menus.filter((m) => m.items.length > 0);
  const year = new Date().getFullYear();

  const links = (m: StorefrontNavMenu) => m.items.flatMap((i) => [i, ...i.children]);
  const hasContact = contactItems(contact).length > 0 || socialItems(social).length > 0;

  return (
    <footer className="bg-inverse text-paper">
      {/* Phone: logo, collapsible columns, copyright (Figma 1:10765). Contact details get their own row. */}
      <div className="flex flex-col px-4 pt-10 pb-8 md:hidden">
        <div className="pb-6">
          <StoreLogo store={store} onDark />
        </div>
        {columns.map((m) => (
          <Accordion key={m.title} title={m.title}>
            <ul className="flex flex-col gap-3.5">
              {links(m).map((l) => (
                <li key={l.id}>
                  <NavLink href={l.href} className="type-body-m opacity-75 hover:underline hover:opacity-100">
                    {l.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </Accordion>
        ))}
        {hasContact ? (
          <Accordion title="Contact">
            <div className="flex flex-col gap-4">
              <ContactList contact={contact} />
              <SocialLinksRow social={social} />
            </div>
          </Accordion>
        ) : null}
        {payments.length > 0 ? (
          <Accordion title="Pay with">
            <PaymentBadges payments={payments} />
          </Accordion>
        ) : null}
        <p className="type-body-s opacity-65">
          © {year} {store.name}
        </p>
      </div>

      {/* Tablet 1:10621 stacks the brand block over the columns; desktop 1:10700 sets them side by side. */}
      <div className="hidden flex-col gap-10 px-10 pt-14 pb-8 md:flex lg:gap-14 lg:px-20 lg:pt-20">
        <div className="flex flex-col gap-10 lg:flex-row lg:gap-12">
          <div className="flex flex-col items-start gap-5 lg:w-[360px] lg:shrink-0">
            <StoreLogo store={store} onDark />
            {tagline ? <p className="type-body-m hidden opacity-80 lg:block">{tagline}</p> : null}
            <ContactList contact={contact} />
            <SocialLinksRow social={social} />
          </div>

          <div className="flex flex-1 gap-8 lg:gap-12">
            {columns.map((m) => (
              <Column key={m.title} menu={m} />
            ))}
            {payments.length > 0 ? (
              <div className="flex min-w-0 flex-1 flex-col gap-3.5">
                <h2 className="type-h3">Pay with</h2>
                <PaymentBadges payments={payments} />
              </div>
            ) : null}
          </div>
        </div>

        <div className="type-body-s flex flex-row items-center justify-between gap-6 border-t border-line pt-6">
          <p className="opacity-65">
            © {year} {store.name}
          </p>
        </div>
      </div>
    </footer>
  );
}
