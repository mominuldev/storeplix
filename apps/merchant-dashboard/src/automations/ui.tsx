import type { AutomationMessage, MarketingChannel, RecipeKey } from '@storeplix/types';
import { AUTOMATION_LIMITS } from '@storeplix/types';
import { Badge, Button, buttonVariants, Chip, cn, Modal, type BadgeTone } from '@storeplix/ui';
import {
  AlertTriangle,
  Check,
  Clock,
  CreditCard,
  Lock,
  Mail,
  Megaphone,
  MessageCircle,
  Package,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  Sparkles,
  Star,
  Tag,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { MessageEditor } from '../campaigns/MessageSection';
import { useStoreScope } from '../catalog/scope';
import { mergeFieldsFor, messageProblem, renderAutomationSms, type RunIconKind } from './automations';

// Shared Automations pieces (Figma 140:30336 / 141:30622 / 71:20614): card (radius 16, p 24, elevation 1), trigger →
// action tags (Tag 39:4554 info / brand), icon badge (36px, radius 10), flow step card (WHEN / IF / THEN / OTHERWISE),
// connector with tag, plan note, and the message dialog that reuses the 8.5 message editor with a 3-part cap.

export function Card({ title, subtitle, action, children, className, id }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  const hid = useId();
  return (
    <section id={id} aria-labelledby={hid} className={cn('flex min-w-0 flex-col rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6', className)}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={hid} className="text-body-lg font-medium text-text-primary">
            {title}
          </h2>
          {subtitle && <p className="text-body text-text-secondary">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function RecipeTags({ trigger, action }: { trigger: string; action: string }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Badge size="sm" tone="info">
        {trigger}
      </Badge>
      <span aria-hidden className="text-caption font-medium text-text-muted">
        →
      </span>
      <span className="sr-only">then</span>
      <Badge size="sm" tone="brand">
        {action}
      </Badge>
    </span>
  );
}

const toneBg: Record<BadgeTone, string> = {
  neutral: 'bg-surface-subtle text-text-secondary',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  brand: 'bg-brand-50 text-brand-600',
};

export function IconBadge({ icon: Icon, tone = 'brand', size = 36, className }: { icon: LucideIcon; tone?: BadgeTone; size?: 24 | 32 | 36 | 40; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center', size === 40 ? 'rounded-md' : 'rounded-[10px]', toneBg[tone], className)}
      style={{ width: size, height: size }}
    >
      <Icon className={size === 24 ? 'size-3.5' : size === 40 ? 'size-5' : 'size-[18px]'} />
    </span>
  );
}

export const runIconOf: Record<RunIconKind, LucideIcon> = { check: Check, refresh: RefreshCw, alert: AlertTriangle, users: Users, mail: Mail };

/** `RecipeCard.icon` (UI icon name) → lucide icon; unknown names fall back to sparkles. */
const RECIPE_ICONS: Record<string, LucideIcon> = {
  cart: ShoppingCart,
  'shopping-cart': ShoppingCart,
  megaphone: Megaphone,
  star: Star,
  users: Users,
  user: Users,
  refresh: RotateCcw,
  return: RotateCcw,
  'rotate-ccw': RotateCcw,
  package: Package,
  box: Package,
  inventory: Package,
  mail: Mail,
  card: CreditCard,
  truck: Truck,
  tag: Tag,
  chat: MessageCircle,
  clock: Clock,
};
const RECIPE_DEFAULT_ICON: Record<RecipeKey, LucideIcon> = {
  checkout_recovery: ShoppingCart,
  thank_you: Megaphone,
  vip_tag: Users,
  return_flag: RotateCcw,
  low_stock: Package,
};
export const recipeIcon = (recipe: RecipeKey, name?: string): LucideIcon => (name && RECIPE_ICONS[name]) || RECIPE_DEFAULT_ICON[recipe] || Sparkles;

/** Plan note (Free plan, P86-17): "Automations are part of the Starter plan." + See plans. */
export function AutomationPlanNote({ canSeePlans }: { canSeePlans: boolean }) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-2.5 rounded-lg bg-brand-50 px-4 py-3">
      <Lock aria-hidden className="size-4 shrink-0 text-brand-600" />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">Automations are part of the Starter plan.</p>
      {canSeePlans && (
        <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          See plans
        </Link>
      )}
    </div>
  );
}

export function PausedPill() {
  return (
    <Badge tone="warning" dot>
      Paused — not in your plan
    </Badge>
  );
}

/** Quiet hours note (140:31117) — copy per §10.1. */
export function QuietHoursNote({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2.5', className)}>
      <Clock aria-hidden className="size-4 shrink-0 text-text-muted" />
      <p className="min-w-0 flex-1 text-caption text-text-secondary">Quiet hours 9 PM – 9 AM: messages wait until morning. Max 2 automated messages per customer a day.</p>
    </div>
  );
}

/** Flow step card (141:31219 / 141:31289 / 141:31369): icon badge, eyebrow, title, optional trailing control. */
export function FlowStep({ icon, tone, eyebrow, title, trailing, children, className, dashed }: { icon: LucideIcon; tone: BadgeTone; eyebrow: string; title: ReactNode; trailing?: ReactNode; children?: ReactNode; className?: string; dashed?: boolean }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'flex w-full min-w-0 flex-col gap-3.5 rounded-card border p-4 sm:p-5',
        dashed ? 'border-dashed border-border-default bg-surface-card' : 'border-border-default bg-surface-card shadow-elevation-1',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <IconBadge icon={icon} tone={tone} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-caption font-medium text-text-muted uppercase">{eyebrow}</p>
          <h3 id={id} className="text-body-lg font-medium text-text-primary">
            {title}
          </h3>
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

/** 2px connector, with an optional tag/pill in the middle ("Yes", "Otherwise", "Wait 30 minutes"). */
export function Connector({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center">
      <span aria-hidden className="h-4 w-0.5 bg-border-default" />
      {children}
      {children && <span aria-hidden className="h-4 w-0.5 bg-border-default" />}
    </div>
  );
}

export function ConnectorTag({ children }: { children: ReactNode }) {
  return (
    <Badge size="sm" tone="neutral">
      {children}
    </Badge>
  );
}

/** Wait pill (71:20614 "Wait 30 minutes"): clock + label, optionally an inline control. */
export function WaitPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-full bg-surface-subtle px-3 py-1 text-caption text-text-secondary">
      <Clock aria-hidden className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

/** Compact inline select for wait pills / step options. */
export function InlineSelect({ label, value, onChange, options, disabled, className }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; disabled?: boolean; className?: string }) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn('rounded-sm border border-border-default bg-surface-card px-1.5 py-0.5 text-caption font-medium text-text-primary outline-none focus-visible:shadow-focus disabled:opacity-60', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * "Edit message" dialog: channel (SMS / Email) + the 8.5 message editor with this recipe's merge tags and the 3-part
 * counter (P86-7). Applies to the draft; the page's "Save changes" persists it.
 */
export function MessageDialog({
  open,
  title,
  recipe,
  message,
  couponCode,
  couponRequired,
  allowEmail = true,
  emailNote,
  mergeFields,
  maxParts = AUTOMATION_LIMITS.sms_max_parts,
  onClose,
  onApply,
}: {
  open: boolean;
  title: string;
  recipe: RecipeKey;
  message: AutomationMessage;
  couponCode: string | null;
  couponRequired?: boolean;
  allowEmail?: boolean;
  emailNote?: string;
  /** `recipe_schema.merge_fields` (C3/C11); defaults to the recipe's list from packages/types. */
  mergeFields?: readonly string[];
  /** `recipe_schema.sms_max_parts` (3). */
  maxParts?: number;
  onClose: () => void;
  onApply: (m: AutomationMessage) => void;
}) {
  const scope = useStoreScope();
  // Mounted only while open (callers render it conditionally), so the draft starts from the current message.
  const [draft, setDraft] = useState<AutomationMessage>(message);
  const [error, setError] = useState<string | null>(null);
  const shopName = scope.store?.name ?? 'Shop';
  const host = scope.store?.primary_domain ?? 'shop.storeplix.com';
  const sms = renderAutomationSms(draft.body, { language: draft.language, shopName, host, couponCode });
  const setChannel = (channel: MarketingChannel) => setDraft((d) => ({ ...d, channel, subject: channel === 'email' ? (d.subject ?? '') : null }));
  const apply = () => {
    const p = messageProblem(recipe, draft, draft.channel === 'sms' ? sms.count.parts : null, { couponRequired, maxParts });
    if (p) {
      setError(p);
      return;
    }
    onApply({ ...draft, subject: draft.channel === 'email' ? (draft.subject ?? '').trim() : null });
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description="Customers who opted out never get it. Quiet hours 9 PM – 9 AM."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply}>Use this message</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {allowEmail && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Channel">
            <Chip check={false} selected={draft.channel === 'sms'} onClick={() => setChannel('sms')}>
              SMS
            </Chip>
            <Chip check={false} selected={draft.channel === 'email'} onClick={() => setChannel('email')}>
              Email
            </Chip>
            {emailNote && draft.channel === 'email' && <span className="text-caption text-text-muted">{emailNote}</span>}
          </div>
        )}
        <MessageEditor
          channel={draft.channel}
          language={draft.language}
          body={draft.body}
          subject={draft.subject ?? ''}
          coupon={null}
          product={null}
          sms={sms}
          errors={error ? { body: error } : {}}
          onLanguage={(language) => setDraft((d) => ({ ...d, language }))}
          onBody={(body) => {
            setError(null);
            setDraft((d) => ({ ...d, body }));
          }}
          onSubject={(subject) => setDraft((d) => ({ ...d, subject }))}
          onCoupon={() => undefined}
          onProduct={() => undefined}
          maxParts={maxParts}
          mergeFields={mergeFields ? mergeFieldsFor(recipe).filter((f) => mergeFields.includes(`{${f.field}}`)) : mergeFieldsFor(recipe)}
          templates={null}
          pickers={false}
          note={couponCode ? `{coupon} becomes ${couponCode}.` : undefined}
        />
      </div>
    </Modal>
  );
}
