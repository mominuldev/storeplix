import type { SocialLinks, StoreContact } from '@storeplix/types';
import { mailtoHref, socialHref, telHref, whatsappHref, type SocialNetwork } from '@/lib/contact';
import { Icon, type IconName } from './icon';

export interface ContactItem {
  key: 'phone' | 'whatsapp' | 'email' | 'hours';
  label: string;
  value: string;
  href: string | null;
}

/** Only items with a value (and, for links, a valid href) are returned. */
export function contactItems(contact: StoreContact): ContactItem[] {
  const items: ContactItem[] = [];
  const phone = contact.phone && telHref(contact.phone);
  if (phone) items.push({ key: 'phone', label: 'Call', value: contact.phone!, href: phone });
  const wa = contact.whatsapp && whatsappHref(contact.whatsapp);
  if (wa) items.push({ key: 'whatsapp', label: 'WhatsApp', value: contact.whatsapp!, href: wa });
  const mail = contact.email && mailtoHref(contact.email);
  if (mail) items.push({ key: 'email', label: 'Email', value: contact.email!, href: mail });
  if (contact.support_hours) items.push({ key: 'hours', label: 'Hours', value: contact.support_hours, href: null });
  return items;
}

const NETWORKS: Array<{ key: SocialNetwork; label: string; icon: IconName }> = [
  { key: 'facebook', label: 'Facebook', icon: 'facebook' },
  { key: 'instagram', label: 'Instagram', icon: 'instagram' },
  { key: 'youtube', label: 'YouTube', icon: 'youtube' },
];

export function socialItems(social: SocialLinks) {
  return NETWORKS.flatMap((n) => {
    const href = socialHref(n.key, social[n.key]);
    return href ? [{ ...n, href }] : [];
  });
}

/** Figma footer "Social" row (1:10706): 44px outlined circles. */
export function SocialLinksRow({ social, tone = 'dark' }: { social: SocialLinks; tone?: 'dark' | 'light' }) {
  const items = socialItems(social);
  if (items.length === 0) return null;
  const ring = tone === 'dark' ? 'border-paper hover:bg-paper/10' : 'border-line text-ink hover:bg-sunken';
  return (
    <ul className="flex items-center gap-3">
      {items.map((s) => (
        <li key={s.key}>
          <a
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={s.label}
            className={`flex size-11 items-center justify-center rounded-full border ${ring}`}
          >
            <Icon name={s.icon} />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Contact block (footer / coming soon). Phone `tel:`, WhatsApp `wa.me`, email `mailto:`, hours as text. */
export function ContactList({ contact, className = '' }: { contact: StoreContact; className?: string }) {
  const items = contactItems(contact);
  if (items.length === 0) return null;
  return (
    <ul className={`flex flex-col gap-2 ${className}`}>
      {items.map((item) => (
        <li key={item.key} className="type-body-m">
          <span className="opacity-75">{item.label}: </span>
          {item.href ? (
            <a
              href={item.href}
              className="hover:underline"
              {...(item.key === 'whatsapp' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {item.value}
            </a>
          ) : (
            <span>{item.value}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
