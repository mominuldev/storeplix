import { isApiError } from '@storeplix/api-client';
import type { CustomerRisk, GuardHold, Order, OrderGuard as Guard, RiskTier } from '@storeplix/types';
import { Badge, Button, cn, copyText, RiskBadge } from '@storeplix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { CreditCard, Loader2, Phone } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { formatBdt } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { localPhone } from '../commerce/format';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { activeLink, gatewayMeta } from '../payments/gateways';
import { usePaymentInvalidate } from '../payments/queries';
import { holdLabels, reasonsSentence } from './fraud';
import { useReleaseHold } from './queries';

// PHASE-8-8 §10.2 order-detail pieces (33:3676): hold Tag beside "Pending" (composed, P88-2), next-step banner 33:3923
// for `advance` (Confirm without advance / Resend link / Copy payment link), composed banners for `call_first`
// (Release and confirm / Cancel as fake) and `checking`, Delivery record card 33:4122 with the "Your shop" bar only
// (Steadfast / Pathao / RedX bars hidden, P88-7), and the "why" box of Ask for an advance 144:46570.

/** Warning Tag beside the Pending status: "Call first" / "Waiting for advance" / "Checking…". */
export function HoldTag({ hold, className }: { hold: GuardHold; className?: string }) {
  return (
    <Badge tone="warning" dot className={className}>
      {holdLabels[hold]}
    </Badge>
  );
}

/** Poll the order while the check runs (`checking` is replaced within seconds by `CheckOrderRisk`). */
export const CHECKING_POLL_MS = 3000;
function useCheckingPoll(order: Order) {
  const qc = useQueryClient();
  const scope = useStoreScope();
  const checking = order.guard?.hold === 'checking';
  useEffect(() => {
    if (!checking) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: keys.order(scope, order.id) }), CHECKING_POLL_MS);
    return () => clearInterval(t);
  }, [checking, qc, scope, order.id]);
}

function Banner({ icon, title, text, actions, label }: { icon: ReactNode; title: ReactNode; text: ReactNode; actions?: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="flex flex-col gap-3 rounded-card border border-warning/30 bg-warning-bg px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-card text-warning [&_svg]:size-5">{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-body-lg font-medium text-text-primary">{title}</p>
          <p className="text-body text-text-secondary">{text}</p>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">{actions}</div>}
    </section>
  );
}

/** "this buyer delivered 7 of 12 parcels" (own-shop record of the check). */
function recordClause(g: Guard): string {
  const r = g.record;
  if (!r || r.total === 0) return 'this is a new number at your shop';
  return `this buyer delivered ${r.delivered} of ${r.total} ${r.total === 1 ? 'parcel' : 'parcels'}`;
}

const minutesAgo = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/**
 * Next-step banner for a held order. `canProcess` = `orders.process` (release, confirm, resend). `onCancelFake` opens the
 * cancel dialog with reason "Fake order".
 */
export function GuardBanner({ order, canProcess, onCancelFake }: { order: Order; canProcess: boolean; onCancelFake: () => void }) {
  useCheckingPoll(order);
  const g = order.guard;
  const { storeId } = useStoreScope();
  const release = useReleaseHold();
  const invalidate = usePaymentInvalidate();
  const [confirming, setConfirming] = useState(false);
  const link = (order.payment_links ?? []).find((l) => l.id === g?.payment_link_id && l.status === 'active') ?? activeLink(order);

  if (!g?.hold) return null;

  /** "Confirm without advance" / "Release and confirm" = release, then confirm (§5.3). */
  const releaseAndConfirm = async () => {
    setConfirming(true);
    try {
      await release.mutateAsync(order.id);
      const confirmed = await api.orders.confirm(storeId!, order.id);
      toast(`${confirmed.number} · Released and confirmed.`);
    } catch (e) {
      if (isApiError(e) && e.code === 'order_not_held') toast('This order was already released. We reloaded it.', 'error');
      else toast(errorMessage(e, 'We couldn’t confirm this order.'), 'error');
    } finally {
      setConfirming(false);
      await invalidate.order(order.id, order.customer.id);
    }
  };

  const resend = async () => {
    if (!link) return;
    try {
      await api.paymentLinks.resend(storeId!, order.id, link.id);
      toast(`Link sent again to ${localPhone(order.contact.phone)}.`);
      await invalidate.order(order.id);
    } catch (e) {
      toast(isApiError(e) && e.status === 429 ? 'You can resend a link 3 times an hour. Try again later.' : errorMessage(e, 'We couldn’t resend the link.'), 'error');
    }
  };

  if (g.hold === 'checking') {
    return (
      <Banner
        label="Fake order check"
        icon={<Loader2 aria-hidden className="animate-spin" />}
        title="Checking this order…"
        text="The guard is looking at this number’s orders at your shop. It takes a few seconds — you can confirm once it’s done."
      />
    );
  }

  if (g.hold === 'advance') {
    const provider = link ? gatewayMeta[link.provider].short : 'gateway';
    return (
      <Banner
        label="Next step"
        icon={<CreditCard aria-hidden />}
        title={`Next step: waiting for ${link ? formatBdt(link.amount) : 'the'} advance`}
        text={`Held automatically — ${recordClause(g)}. ${link ? `${provider} payment link sent ${minutesAgo(link.created_at)}; the` : 'The'} order confirms itself as soon as the gateway reports payment.`}
        actions={
          canProcess && (
            <>
              <Button variant="ghost" loading={confirming} onClick={() => void releaseAndConfirm()}>
                Confirm without advance
              </Button>
              {link && (
                <Button variant="secondary" onClick={() => void resend()}>
                  Resend link
                </Button>
              )}
              {link && (
                <Button onClick={async () => toast((await copyText(link.url)) ? 'Payment link copied.' : link.url)}>
                  Copy payment link
                </Button>
              )}
            </>
          )
        }
      />
    );
  }

  const why = reasonsSentence(g);
  return (
    <Banner
      label="Next step"
      icon={<Phone aria-hidden />}
      title={`Held for a call${why ? ` — ${why.charAt(0).toLowerCase()}${why.slice(1)}` : ''}`}
      text={`Call ${order.contact.name} on ${localPhone(order.contact.phone)} before you confirm. The order waits in Pending until someone releases it.`}
      actions={
        canProcess && (
          <>
            <Button variant="secondary" className="text-danger" onClick={onCancelFake} disabled={!order.can.cancel}>
              Cancel as fake
            </Button>
            <Button loading={confirming} onClick={() => void releaseAndConfirm()}>
              Release and confirm
            </Button>
          </>
        )
      }
    />
  );
}

const rateTone: Record<RiskTier, { text: string; bar: string }> = {
  risky: { text: 'text-danger', bar: 'bg-danger' },
  careful: { text: 'text-warning', bar: 'bg-warning' },
  good: { text: 'text-success', bar: 'bg-success' },
  new: { text: 'text-text-secondary', bar: 'bg-text-muted' },
};

/** Suggested next step under the record (33:4122 grey box). */
function suggestion(tier: RiskTier, order: Order): string {
  switch (tier) {
    case 'risky':
      return 'Suggested: call before you confirm, or ask for an advance.';
    case 'careful':
      return order.shipping_amount > 0 ? `Suggested: take the ${formatBdt(order.shipping_amount)} delivery charge first, then confirm.` : 'Suggested: take a part payment first, then confirm.';
    case 'good':
      return 'Suggested: confirm as usual.';
    case 'new':
      return 'First order from this number at your shop.';
  }
}

/**
 * Delivery record 33:4122: tier badge, big rate, "d of t parcels delivered", the "Your shop" bar only (P88-7), a
 * suggestion and "Block this number" (with `fraud.manage`). Uses the check's record, else the customer's own-shop tier.
 */
export function DeliveryRecordCard({ order, onBlock }: { order: Order; onBlock?: () => void }) {
  const g = order.guard;
  const risk: CustomerRisk | null =
    g?.tier && g.record ? { tier: g.tier, rate: g.rate, delivered: g.record.delivered, total: g.record.total } : (order.customer.risk ?? null);
  if (!risk) return null;
  const tone = rateTone[risk.tier];
  const shop = g?.record?.sources.find((s) => s.key === 'shop') ?? { delivered: risk.delivered, total: risk.total };
  const width = shop.total > 0 ? (shop.delivered / shop.total) * 100 : 0;
  return (
    <section aria-label="Delivery record" className="flex flex-col gap-3.5 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:px-6 sm:py-[22px]">
      <div className="flex items-center justify-between gap-2.5">
        <h2 className="text-body-lg font-medium text-text-primary">Delivery record</h2>
        <RiskBadge tier={risk.tier} size="sm" />
      </div>
      <p className="flex items-baseline gap-2">
        <span className={cn('text-heading-32 font-bold', tone.text)}>{risk.rate === null ? '—' : `${risk.rate}%`}</span>
        <span className="text-body text-text-secondary">
          {risk.total === 0 ? 'No parcels at your shop yet' : `${risk.delivered} of ${risk.total} ${risk.total === 1 ? 'parcel' : 'parcels'} delivered`}
        </span>
      </p>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-body text-text-secondary">
          <span>Your shop</span>
          <span className="font-medium text-text-primary">
            {shop.delivered}/{shop.total}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-subtle" role="presentation">
          <div data-testid="record-bar-shop" className={cn('h-1.5 rounded-full', tone.bar)} style={{ width: `${width}%` }} />
        </div>
      </div>
      <p className="rounded-lg bg-surface-canvas px-3 py-2.5 text-caption text-text-secondary">{suggestion(risk.tier, order)}</p>
      {onBlock && (
        <button type="button" onClick={onBlock} className="self-start text-body font-medium text-danger outline-none hover:underline focus-visible:shadow-focus">
          Block this number
        </button>
      )}
    </section>
  );
}

/** Ask for an advance 144:46570 "why" box: tier badge + the own-shop record in words. */
export function AdvanceWhy({ order }: { order: Order }) {
  const g = order.guard;
  const tier = g?.tier ?? order.customer.risk?.tier ?? null;
  if (!tier || tier === 'good') return null;
  const d = g?.record?.delivered ?? order.customer.risk?.delivered ?? 0;
  const t = g?.record?.total ?? order.customer.risk?.total ?? 0;
  const text =
    tier === 'new' || t === 0
      ? 'This number hasn’t received a parcel from your shop yet. An advance makes sure the order is real.'
      : `Only ${d} of ${t} ${t === 1 ? 'parcel' : 'parcels'} delivered at your shop. An advance cuts the chance of a return.`;
  return (
    <div aria-label="Why ask for an advance" className="flex items-start gap-3 rounded-lg bg-warning-bg px-3.5 py-3">
      <RiskBadge tier={tier} size="sm" className="mt-0.5" />
      <p className="text-body text-text-primary">{text}</p>
    </div>
  );
}
