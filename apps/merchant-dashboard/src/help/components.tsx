import type { HelpArticleLink, HelpCategory, HelpCategoryIcon, HelpLanguage, SupportAttachment, SupportTicketPriority, SupportTicketStatus } from '@storeplix/types';
import { Badge, Button, Chip, cn } from '@storeplix/ui';
import {
  AlertTriangle,
  BarChart3,
  Box,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  FileText,
  Globe,
  Image as ImageIcon,
  Mail,
  Megaphone,
  MessageSquare,
  Palette,
  Rocket,
  Search,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useReadOnly } from '../impersonation/hooks';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { helpErrorText } from './errors';
import { attachmentMeta, PRIORITY_LABELS, PRIORITY_TONES, TICKET_STATUS_TONES, ticketStatusLabel } from './help';

// PHASE-8-9C §13 shared pieces (Figma section 71:21271): breadcrumb, article language chips, Help / Topic card
// 71:24258, Help / Article link 71:24265, search box, Talk to us / Still stuck cards (Email & tickets only), status
// pills, attachment chips and the state banners of 2130:965.

export const bnClass = (lang: HelpLanguage | null | undefined) => (lang === 'bn' ? 'font-bangla' : undefined);

export function HelpBreadcrumb({ items }: { items: { label: ReactNode; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-caption font-medium sm:text-body">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight aria-hidden className="size-3.5 text-text-muted" />}
          {it.to ? (
            <Link to={it.to} className="text-brand-600 hover:underline">
              {it.label}
            </Link>
          ) : (
            <span aria-current="page" className="text-text-primary">
              {it.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** English / বাংলা chips (Components · Chip 39:4594, no check). */
export function LanguageToggle({ value, onChange, label = 'Article language' }: { value: HelpLanguage; onChange: (l: HelpLanguage) => void; label?: string }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center gap-2">
      <Chip check={false} selected={value === 'en'} onClick={() => onChange('en')}>
        English
      </Chip>
      <Chip check={false} selected={value === 'bn'} onClick={() => onChange('bn')} className="font-bangla">
        বাংলা
      </Chip>
    </div>
  );
}

const CATEGORY_ICONS: Record<HelpCategoryIcon, LucideIcon> = {
  rocket: Rocket,
  box: Box,
  cart: ShoppingCart,
  truck: Truck,
  card: CreditCard,
  palette: Palette,
  megaphone: Megaphone,
  globe: Globe,
  users: Users,
  chart: BarChart3,
  settings: Settings,
  message: MessageSquare,
};

export function CategoryIcon({ icon, className }: { icon: HelpCategoryIcon; className?: string }) {
  const Icon = CATEGORY_ICONS[icon] ?? FileText;
  return <Icon aria-hidden className={className} />;
}

export const articlePath = (slug: string, lang?: HelpLanguage) => `/help/articles/${encodeURIComponent(slug)}${lang === 'bn' ? '?lang=bn' : ''}`;
export const categoryPath = (slug: string, lang?: HelpLanguage) => `/help/categories/${encodeURIComponent(slug)}${lang === 'bn' ? '?lang=bn' : ''}`;

/** Help / Topic card 71:24258: 40px brand-50 icon tile, name, description, "n articles". */
export function TopicCard({ category, lang }: { category: HelpCategory; lang: HelpLanguage }) {
  return (
    <Link
      to={categoryPath(category.slug, lang)}
      className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 outline-none transition-colors hover:border-brand-100 focus-visible:shadow-focus"
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
        <CategoryIcon icon={category.icon} className="size-5" />
      </span>
      <span className={cn('text-body-lg font-medium text-text-primary', bnClass(lang))}>{category.name}</span>
      {category.description && <span className={cn('text-body text-text-secondary', bnClass(lang))}>{category.description}</span>}
      <span className="text-caption font-medium text-brand-600">
        {category.article_count} {category.article_count === 1 ? 'article' : 'articles'}
      </span>
    </Link>
  );
}

/** Help / Article link 71:24265: 18px icon, title + "Topic · n min read", chevron. */
export function ArticleLinkRow({ link, lang, className }: { link: HelpArticleLink; lang?: HelpLanguage; className?: string }) {
  return (
    <Link to={articlePath(link.slug, lang)} className={cn('flex items-center gap-3 py-3 outline-none focus-visible:shadow-focus', className)}>
      <FileText aria-hidden className="size-[18px] shrink-0 text-text-secondary" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('text-body font-medium text-text-primary', bnClass(link.language))}>{link.title}</span>
        <span className="text-caption text-text-muted">
          {link.category.name} · {link.read_minutes} min read
        </span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-text-muted" />
    </Link>
  );
}

/** Search field with a Search button (hero 72:22575 and the search page bar). */
export function HelpSearchBox({
  initial = '',
  onSearch,
  placeholder = 'Search guides — English or বাংলা',
  onClear,
  className,
  autoFocus,
}: {
  initial?: string;
  onSearch: (q: string) => void;
  placeholder?: string;
  onClear?: () => void;
  className?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length >= 2) onSearch(q.trim());
  };
  return (
    <form role="search" onSubmit={submit} className={cn('flex w-full items-center gap-3 rounded-lg border border-border-default bg-surface-card py-2 pr-2 pl-4 shadow-elevation-1', className)}>
      <Search aria-hidden className="size-5 shrink-0 text-text-muted" />
      <input
        type="search"
        aria-label="Search guides"
        value={q}
        maxLength={100}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent py-2 text-body-lg text-text-primary outline-none placeholder:text-text-muted"
      />
      {onClear && q && (
        <button
          type="button"
          onClick={() => {
            setQ('');
            onClear();
          }}
          className="hidden text-body font-medium text-text-secondary hover:text-text-primary sm:block"
        >
          Clear
        </button>
      )}
      <Button type="submit" disabled={q.trim().length < 2}>
        Search
      </Button>
    </form>
  );
}

/**
 * Talk to us (home) / Still stuck (article) / Didn't find your answer (search): only Email & tickets → New ticket
 * (Q327: no live chat, call or WhatsApp). Without `support.manage`: "Ask your shop owner…".
 */
export function ContactCard({
  variant,
  canContact,
  onNewTicket,
}: {
  variant: 'home' | 'stuck' | 'search';
  canContact: boolean;
  onNewTicket: () => void;
}) {
  const readOnly = useReadOnly();
  const title = variant === 'home' ? 'Talk to us' : variant === 'stuck' ? 'Still stuck?' : 'Didn’t find your answer?';
  const body =
    variant === 'home'
      ? 'Our team in Dhaka answers by email and in your tickets.'
      : variant === 'stuck'
        ? 'Our Dhaka team can check your shop for you. Send a ticket with the details.'
        : 'Send us a ticket with the order attached. Our Dhaka team replies by email and here.';
  const tinted = variant !== 'home';
  return (
    <section className={cn('flex flex-col gap-4 rounded-card border p-5 shadow-elevation-1', tinted ? 'border-brand-100 bg-brand-50' : 'border-border-default bg-surface-card')}>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
        <p className="text-body text-text-secondary">{canContact ? body : 'Ask your shop owner or a manager to contact Store Plix support for you.'}</p>
      </div>
      {canContact &&
        (variant === 'home' ? (
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
              <Mail aria-hidden className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-body font-medium text-text-primary">Email &amp; tickets</span>
              <span className="text-caption text-text-muted">We reply here and by email</span>
            </span>
            <Button size="sm" variant="secondary" disabled={readOnly} onClick={onNewTicket}>
              New ticket
            </Button>
          </div>
        ) : (
          <Button disabled={readOnly} onClick={onNewTicket} className={variant === 'stuck' ? undefined : 'w-full'} variant={variant === 'stuck' ? 'secondary' : 'primary'}>
            {variant === 'stuck' ? 'Create a ticket' : 'Contact support'}
          </Button>
        ))}
    </section>
  );
}

export function TicketStatusBadge({ status, size }: { status: SupportTicketStatus; size?: 'sm' | 'md' }) {
  return (
    <Badge tone={TICKET_STATUS_TONES[status]} dot size={size}>
      {ticketStatusLabel(status)}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: SupportTicketPriority }) {
  return (
    <Badge tone={PRIORITY_TONES[priority]} size="sm">
      {PRIORITY_LABELS[priority]}
    </Badge>
  );
}

/** File chip: opens a signed 5-minute link (hidden in a support session, P89C-15). */
export function AttachmentChip({ a, inverse, meta }: { a: SupportAttachment; inverse?: boolean; meta?: string }) {
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const link = await api.help.attachmentLink(a.id);
      window.open(link.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast(helpErrorText(e, 'We couldn’t open this file.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const Icon = a.kind === 'pdf' ? FileText : ImageIcon;
  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={readOnly || busy || a.status !== 'ready'}
      title={readOnly ? 'Attachments are hidden in a support session' : undefined}
      className={cn(
        'flex max-w-full items-center gap-2 rounded-md border px-3 py-2 text-left outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
        inverse ? 'border-border-default bg-surface-card' : 'border-border-default bg-surface-card hover:bg-surface-subtle',
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-text-secondary" />
      <span className="min-w-0 truncate text-body font-medium text-text-primary">{readOnly ? 'Hidden' : a.filename}</span>
      <span className="shrink-0 text-caption text-text-muted">{meta ?? attachmentMeta(a)}</span>
    </button>
  );
}

const bannerTones = {
  info: 'bg-info-bg',
  success: 'bg-success-bg',
  danger: 'bg-danger-bg',
  warning: 'bg-warning-bg',
} as const;

/** State banners (2130:965): icon, message, one action on a white button. */
export function HelpBanner({ tone, children, action }: { tone: keyof typeof bannerTones; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'danger' || tone === 'warning' ? AlertTriangle : CheckCircle2;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-center gap-3 rounded-lg px-4 py-3 text-body text-text-primary', bannerTones[tone])}>
      <Icon aria-hidden className="size-4 shrink-0 text-text-secondary" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export function BannerButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 rounded-md bg-surface-card px-3 py-1.5 text-caption font-medium text-text-primary shadow-elevation-1 outline-none hover:bg-surface-subtle focus-visible:shadow-focus">
      {children}
    </button>
  );
}

/** First name of the signed-in member ("Hi Rafiq"). */
export function useFirstName(): string | null {
  const { user } = useAuth();
  const name = user?.name?.trim();
  return name ? (name.split(/\s+/)[0] ?? null) : null;
}
