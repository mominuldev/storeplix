import { isApiError } from '@storeplix/api-client';
import type { GatewayProvider, Order, Payment, PaymentLink, PaymentLinkAmountKind } from '@storeplix/types';
import { Badge, Button, cn, copyText, Dialog, Modal, MoneyInput, PercentInput, ProviderLogo, Select, Toggle } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, CreditCard, Link2, Truck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { dateTime, formatBdt } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { localPhone, newIdempotencyKey, refundMethodLabels } from '../commerce/format';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import {
  advanceAmount,
  advanceError,
  chargeStateLabel,
  DEFAULT_PERCENT_BPS,
  gatewayMeta,
  isGateway,
  LINK_EXPIRY,
  linkGateways,
  paymentLinkSms,
  purposeLabel,
  timeLeft,
  type LinkExpiry,
} from '../payments/gateways';
import { usePaymentGateways, usePaymentInvalidate } from '../payments/queries';
import { useStoreSettings } from '../settings/commerceSettings';
import { refundAmountError } from './transitions';
import { AdvanceWhy } from '../fraud/OrderGuard';

// Order detail · Payments card 33:3676 + Ask for an advance 144:46081 (PHASE-5B §10, P5B-22, P5B-24). Online charges
// with TrxID, links, refunds; "Refund" on a charge row → gateway refund (O A); active-link banner with Copy / Resend /
// Cancel. PHASE-8-8 §10.2: the advance dialog (144:46570) gains the "why" box (RiskBadge + own-shop record); the
// Delivery record card stays on the order page.

function Row({ icon, title, sub, amount, state, action }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; amount: ReactNode; state?: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border-default p-3 sm:flex-nowrap">
      {icon}
      <span className="flex min-w-[calc(100%-48px)] flex-1 flex-col sm:min-w-0">
        <span className="text-body font-semibold text-text-primary">{title}</span>
        {sub && <span className="truncate text-caption text-text-muted">{sub}</span>}
      </span>
      <span className="ml-12 flex items-center gap-3 sm:ml-0">
        <span className="text-body font-semibold whitespace-nowrap text-text-primary">{amount}</span>
        {state}
        {action}
      </span>
    </li>
  );
}

const IconTile = ({ children }: { children: ReactNode }) => <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-subtle text-text-secondary [&_svg]:size-4">{children}</span>;

export function PaymentsCardBody({ order, onRefundCharge }: { order: Order; onRefundCharge: (p: Payment) => void }) {
  const scope = useStoreScope();
  const cod = order.payments.find((p) => p.type === 'charge' && p.provider === 'cod');
  const online = order.payments.filter((p) => p.type === 'charge' && isGateway(p.provider) && p.purpose !== 'test');
  const refunds = order.payments.filter((p) => p.type === 'refund');
  const pastLinks = (order.payment_links ?? []).filter((l) => l.status === 'expired' || l.status === 'cancelled');
  const showCod = order.payment_method === 'cod' || !!cod;
  // PHASE-8-8D §6.3: till payments (manual rows with a session) read "Till · {register}".
  const till = order.payments.filter((p) => p.type === 'charge' && p.provider === 'manual' && !!p.pos_session_id);
  return (
    <ul className="flex flex-col gap-2">
      {online.map((p) => {
        const st = chargeStateLabel(p);
        const provider = p.provider as GatewayProvider;
        return (
          <Row
            key={p.id}
            icon={<ProviderLogo provider={provider} size="sm" />}
            title={purposeLabel[p.purpose] ?? 'Paid online'}
            sub={[gatewayMeta[provider].short, p.provider_trx_id ? `TrxID ${p.provider_trx_id}` : null, dateTime(p.created_at), p.refunded_amount > 0 ? `${formatBdt(p.refunded_amount)} refunded` : null].filter(Boolean).join(' · ')}
            amount={formatBdt(p.amount)}
            state={<Badge tone={st.tone}>{st.label}</Badge>}
            action={
              p.can_refund && scope.canManageRefunds ? (
                <Button size="sm" variant="secondary" onClick={() => onRefundCharge(p)} aria-label={`Refund ${formatBdt(p.amount)} ${gatewayMeta[provider].short} payment`}>
                  Refund
                </Button>
              ) : undefined
            }
          />
        );
      })}
      {till.map((p) => (
        <Row
          key={p.id}
          icon={
            <IconTile>
              <CreditCard aria-hidden />
            </IconTile>
          }
          title={`Till · ${order.pos?.register_name ?? 'POS'}`}
          sub={[p.method ? refundMethodLabels[p.method] : null, p.reference ? `Ref ${p.reference}` : null, p.actor?.name, dateTime(p.created_at)].filter(Boolean).join(' · ')}
          amount={formatBdt(p.amount)}
          state={<Badge tone="success">Paid</Badge>}
        />
      ))}
      {showCod && (
        <Row
          icon={
            <IconTile>
              <Truck aria-hidden />
            </IconTile>
          }
          title="Cash on delivery"
          sub={order.paid_amount > 0 && order.due_amount > 0 ? 'The rest, collected at the door' : 'Collected by you or your courier at the door'}
          amount={formatBdt(cod?.amount ?? order.due_amount)}
          state={<span className="text-caption text-text-muted">{cod ? codState(cod.status) : ''}</span>}
        />
      )}
      {pastLinks.map((l) => (
        <Row
          key={l.id}
          icon={
            <IconTile>
              <Link2 aria-hidden />
            </IconTile>
          }
          title="Payment link"
          sub={[gatewayMeta[l.provider].short, l.created_by?.name, dateTime(l.created_at)].filter(Boolean).join(' · ')}
          amount={formatBdt(l.amount)}
          state={<Badge>{l.status === 'expired' ? 'Expired' : 'Cancelled'}</Badge>}
        />
      ))}
      {refunds.map((r) => (
        <Row
          key={r.id}
          icon={
            r.method === 'gateway' && isGateway(r.provider) ? (
              <ProviderLogo provider={r.provider} size="sm" />
            ) : (
              <IconTile>
                <CreditCard aria-hidden />
              </IconTile>
            )
          }
          title={`Refund · ${r.method === 'gateway' && isGateway(r.provider) ? gatewayMeta[r.provider].short : r.method ? refundMethodLabels[r.method] : 'Manual'}`}
          sub={[r.reference ? `Ref ${r.reference}` : null, r.provider_trx_id ? `TrxID ${r.provider_trx_id}` : null, r.actor?.name, dateTime(r.created_at), r.note].filter(Boolean).join(' · ')}
          amount={`− ${formatBdt(r.amount)}`}
          state={r.status === 'succeeded' ? undefined : <Badge tone={r.status === 'pending' ? 'warning' : 'danger'}>{r.status === 'pending' ? 'Processing' : r.status === 'failed' ? 'Failed' : 'Cancelled'}</Badge>}
        />
      ))}
    </ul>
  );
}

function codState(s: Payment['status']): string {
  return s === 'pending' ? 'At delivery' : s === 'succeeded' ? 'Collected' : s === 'cancelled' ? 'Not collected' : 'Failed';
}

/** Banner for the order's active link (144:46081 "Next step" area): Copy / Resend / Cancel. */
export function ActiveLinkBanner({ order, link }: { order: Order; link: PaymentLink }) {
  const { storeId } = useStoreScope();
  const invalidate = usePaymentInvalidate();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const resend = useMutation({
    mutationFn: () => api.paymentLinks.resend(storeId!, order.id, link.id),
    onSuccess: async () => {
      toast(`Link sent again to ${localPhone(order.contact.phone)}.`);
      await invalidate.order(order.id);
    },
    onError: (e) => toast(isApiError(e) && e.status === 429 ? 'You can resend a link 3 times an hour. Try again later.' : errorMessage(e, 'We couldn’t resend the link.'), 'error'),
  });
  const cancel = useMutation({
    mutationFn: () => api.paymentLinks.cancel(storeId!, order.id, link.id),
    onSuccess: async () => {
      setConfirmCancel(false);
      toast('Payment link cancelled. The order stays as it is.');
      await invalidate.order(order.id);
    },
    onError: async (e) => {
      setConfirmCancel(false);
      toast(isApiError(e) && e.status === 409 ? 'This link was just paid or expired.' : errorMessage(e, 'We couldn’t cancel the link.'), 'error');
      await invalidate.order(order.id);
    },
  });
  return (
    <section aria-label="Payment link" className="flex flex-col gap-3 rounded-card border border-warning bg-warning-bg p-4 sm:flex-row sm:items-center">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-card text-warning">
        <Link2 aria-hidden className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-body font-semibold text-text-primary">
          Waiting for {formatBdt(link.amount)} by {gatewayMeta[link.provider].short}
        </p>
        <p className="text-caption text-text-secondary">
          {[link.sent_via.includes('sms') ? `Link sent by SMS to ${localPhone(order.contact.phone)}` : 'Link created', timeLeft(link.expires_at), link.cancel_if_unpaid ? 'order cancels if unpaid' : null].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
          Cancel link
        </Button>
        <Button size="sm" variant="secondary" loading={resend.isPending} onClick={() => resend.mutate()}>
          Resend
        </Button>
        <Button size="sm" onClick={async () => toast((await copyText(link.url)) ? 'Payment link copied.' : link.url)}>
          <Copy aria-hidden className="size-4" /> Copy link
        </Button>
      </div>
      <Dialog
        open={confirmCancel}
        tone="danger"
        title="Cancel this payment link?"
        description="The customer can’t pay with it any more. The order isn’t changed."
        confirmLabel="Cancel link"
        cancelLabel="Keep link"
        loading={cancel.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => cancel.mutate()}
      />
    </section>
  );
}

const AMOUNT_OPTIONS: { kind: PaymentLinkAmountKind; title: string; hint: string }[] = [
  { kind: 'delivery_charge', title: 'Delivery charge', hint: 'Covers your loss if the parcel comes back' },
  { kind: 'percent', title: 'Part payment', hint: 'Good for bigger orders' },
  { kind: 'full', title: 'Full payment', hint: 'Order becomes prepaid — nothing to collect' },
  { kind: 'custom', title: 'Custom amount', hint: 'Type any amount' },
];

/** Ask for an advance 144:46081 (P5B-22). Idempotency key per dialog open. */
export function AskAdvanceDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const scope = useStoreScope();
  const invalidate = usePaymentInvalidate();
  const gateways = usePaymentGateways();
  const settings = useStoreSettings();
  const options = linkGateways(gateways.data);
  const [key] = useState(newIdempotencyKey);
  const [kind, setKind] = useState<PaymentLinkAmountKind>(order.shipping_amount > 0 && order.shipping_amount <= order.due_amount ? 'delivery_charge' : 'percent');
  const [bps, setBps] = useState<number | null>(DEFAULT_PERCENT_BPS);
  const [custom, setCustom] = useState<number | null>(null);
  const [provider, setProvider] = useState<GatewayProvider | ''>('');
  const [expiry, setExpiry] = useState<LinkExpiry>(120);
  const [cancelIfUnpaid, setCancelIfUnpaid] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const gateway = provider || options[0]?.provider || '';
  const amount = advanceAmount(kind, order, bps, custom);
  const invalid = advanceError(kind, order, bps, custom, formatBdt);
  const lang = settings.data?.commerce?.notifications.sms_language ?? 'bn';
  const host = scope.store?.primary_domain;
  const shop = scope.store?.name ?? '';
  const create = useMutation({
    mutationFn: (sendSms: boolean) =>
      api.paymentLinks.create(
        scope.storeId!,
        order.id,
        {
          amount_kind: kind,
          percent_bps: kind === 'percent' ? bps : null,
          amount: kind === 'custom' ? custom : null,
          provider: gateway as GatewayProvider,
          expires_in_minutes: expiry,
          cancel_if_unpaid: cancelIfUnpaid,
          send_sms: sendSms,
        },
        // A different body under the same key is refused (idempotency_key_mismatch), so the SMS choice is part of it.
        `${key}-${sendSms ? 'sms' : 'copy'}`,
      ),
    onSuccess: async (link, sendSms) => {
      if (sendSms) toast(`Payment link for ${formatBdt(link.amount)} sent to ${localPhone(order.contact.phone)}.`);
      else {
        const ok = await copyText(link.url);
        setCopied(ok);
        toast(ok ? 'Payment link copied. Paste it in WhatsApp or Messenger.' : `Payment link created: ${link.url}`);
      }
      onClose();
      await invalidate.order(order.id);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'payment_link_active') return setError('This order already has an active payment link. Cancel it first.');
      if (isApiError(e) && e.code === 'gateway_not_connected') return setError('That gateway isn’t on at checkout any more. Choose another or check Integrations.');
      if (isApiError(e) && e.code === 'invalid_state_transition') return setError('This order can’t take an advance in its current status.');
      setError(isApiError(e) ? (Object.values(e.fieldErrors ?? {})[0]?.[0] ?? e.message) : errorMessage(e));
    },
  });
  const disabled = !!invalid || amount === null || !gateway || create.isPending;
  const smsUrl = host ? `https://${host}/pay/…` : 'your shop link /pay/…';
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title="Ask for an advance"
      description={`${order.number} · ${order.contact.name} · ${formatBdt(order.due_amount)} due`}
      footerStart={
        <Button variant="ghost" disabled={disabled} loading={create.isPending && create.variables === false} onClick={() => create.mutate(false)}>
          {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />} Copy link instead
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Not now
          </Button>
          <Button disabled={disabled} loading={create.isPending && create.variables === true} onClick={() => create.mutate(true)}>
            Send payment link
          </Button>
        </>
      }
    >
      {options.length === 0 && !gateways.isPending ? (
        <p className="rounded-lg bg-surface-subtle p-4 text-body text-text-secondary">
          Connect bKash or SSLCommerz and turn it on at checkout to send payment links.{' '}
          {scope.canManageIntegrations && (
            <Link to="/integrations" className="font-medium text-brand-600">
              Go to Integrations
            </Link>
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <AdvanceWhy order={order} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-body font-medium text-text-primary">How much?</legend>
            {AMOUNT_OPTIONS.map((o) => {
              const value = advanceAmount(o.kind, order, bps, custom);
              const unavailable = o.kind === 'delivery_charge' && order.shipping_amount <= 0;
              const selected = kind === o.kind;
              return (
                <label
                  key={o.kind}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-lg border p-3.5 has-[:focus-visible]:shadow-focus',
                    selected ? 'border-brand-600 bg-brand-50' : 'border-border-default bg-surface-card',
                    unavailable && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input type="radio" name="advance-kind" value={o.kind} checked={selected} disabled={unavailable} onChange={() => setKind(o.kind)} className="size-4 accent-brand-600" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-body font-medium text-text-primary">
                      {o.title}
                      {o.kind === 'percent' && bps ? ` · ${bps / 100}%` : ''}
                    </span>
                    <span className="text-caption text-text-muted">{o.hint}</span>
                  </span>
                  <span className="text-body font-semibold text-text-primary">{o.kind === 'custom' ? (custom !== null && selected ? formatBdt(custom) : '—') : value !== null ? formatBdt(value) : '—'}</span>
                </label>
              );
            })}
          </fieldset>
          {kind === 'percent' && <PercentInput id="advance-percent" label="Part payment (%)" value={bps} onChange={setBps} error={invalid ?? undefined} />}
          {kind === 'custom' && <MoneyInput id="advance-custom" label="Amount" value={custom} onChange={setCustom} error={custom !== null ? (invalid ?? undefined) : undefined} hint={`Between ${formatBdt(100)} and ${formatBdt(order.due_amount)}`} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Select id="advance-gateway" label="Collect with" value={gateway} onChange={(e) => setProvider(e.target.value as GatewayProvider)}>
              {options.map((a) => (
                <option key={a.provider} value={a.provider}>
                  {gatewayMeta[a.provider].name}
                </option>
              ))}
            </Select>
            <Select id="advance-expiry" label="Link expires in" value={String(expiry)} onChange={(e) => setExpiry(Number(e.target.value) as LinkExpiry)}>
              {LINK_EXPIRY.map((x) => (
                <option key={x.minutes} value={x.minutes}>
                  {x.label}
                </option>
              ))}
            </Select>
          </div>
          <div aria-label="SMS preview" className="flex flex-col gap-1 rounded-lg bg-surface-subtle p-3.5">
            <span className="text-caption text-text-secondary">SMS to {localPhone(order.contact.phone)}</span>
            <p className="text-body break-words text-text-primary">{paymentLinkSms(lang, shop, order.number, amount ?? 0, smsUrl)}</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-body font-medium text-text-primary">Cancel if not paid in time</span>
              <span className="text-caption text-text-muted">Stock is released back to the shop</span>
            </span>
            <Toggle label="Cancel if not paid in time" checked={cancelIfUnpaid} onChange={setCancelIfUnpaid} />
          </div>
          {gateway && (
            <p className="flex items-start gap-2.5 rounded-lg bg-success-bg px-3.5 py-2.5 text-caption text-text-primary">
              <Check aria-hidden className="size-4 shrink-0 text-success" /> Money goes straight to {gatewayMeta[gateway].moneyTo}. The order confirms itself the moment payment arrives — no TrxID to check.
            </p>
          )}
          {error && (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Gateway refund on a charge row (P5B-24, O A). Amount ≤ charge − refunded and ≤ order refundable. */
export function GatewayRefundDialog({ order, payment, onClose }: { order: Order; payment: Payment; onClose: () => void }) {
  const { storeId } = useStoreScope();
  const invalidate = usePaymentInvalidate();
  const provider = payment.provider as GatewayProvider;
  const short = gatewayMeta[provider].short;
  const refundable = Math.max(0, Math.min(payment.amount - (payment.refunded_amount ?? 0), order.paid_amount - order.refunded_amount));
  const [key] = useState(newIdempotencyKey);
  const [amount, setAmount] = useState<number | null>(refundable);
  const [error, setError] = useState<string | null>(null);
  const amountError = amount !== null && amount < 100 ? `Refund at least ${formatBdt(100)}.` : refundAmountError(amount, refundable);
  const refund = useMutation({
    mutationFn: () => api.orders.refund(storeId!, order.id, { amount: amount!, method: 'gateway', payment_id: payment.id }, key),
    onSuccess: async (r) => {
      toast(r.status === 'succeeded' ? `${formatBdt(r.amount)} refunded to the customer’s ${short}.` : `Refund of ${formatBdt(r.amount)} sent to ${short}. It shows as refunded once ${short} confirms.`);
      onClose();
      await invalidate.order(order.id, order.customer.id);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'gateway_refund_rejected') return setError(`${short} refused this refund (${e.message}). Pay the customer back another way and record it with “Record refund”.`);
      if (isApiError(e) && e.code === 'provider_unavailable') return setError(`${short} didn’t answer. Nothing was refunded — try again in a minute.`);
      setError(isApiError(e) ? (e.fieldError('amount') ?? e.fieldError('payment_id') ?? e.message) : errorMessage(e));
    },
  });
  return (
    <Dialog
      open
      title={`Refund to ${short}`}
      description={`The money goes back to the customer’s ${short}${payment.provider_trx_id ? ` (TrxID ${payment.provider_trx_id})` : ''}. Up to ${formatBdt(refundable)}.`}
      confirmLabel="Refund"
      loading={refund.isPending}
      confirmDisabled={!!amountError}
      onCancel={onClose}
      onConfirm={() => refund.mutate()}
    >
      <div className="flex flex-col gap-4">
        <MoneyInput id="gw-refund-amount" label="Amount" value={amount} onChange={setAmount} error={amount !== null ? (amountError ?? undefined) : undefined} />
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
