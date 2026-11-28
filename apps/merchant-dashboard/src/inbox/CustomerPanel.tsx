import type { InboxConversation } from '@storeplix/types';
import { INBOX_CHANNEL_LABELS, INBOX_IDENTITY_LABELS } from '@storeplix/types';
import { buttonVariants, cn, Dialog, formatBdt, OrderStatusBadge, PaymentStatusBadge, Spinner } from '@storeplix/ui';
import { Search, Shield, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatBdPhone } from '../lib/phone';
import { dayTime, durationLabel, riskSummary } from './inbox';
import { useOrderSearch } from './queries';

// PHASE-8-8E §6.3, Figma 2118:51165 side panel (360): Customer head, contact, buyer-risk box, Linked order card
// (Change), Past orders, Conversation facts, View customer. Customer / order blocks show only with
// customers.view / orders.view (the API sends null otherwise).

const RISK_BOX = { success: 'bg-success-bg', warning: 'bg-warning-bg', danger: 'bg-danger-bg', neutral: 'bg-surface-subtle' } as const;

const sinceLabel = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-body">
      <dt className="w-[84px] shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 flex-1 text-text-primary [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function CustomerPanel({
  conversation: c,
  readOnly,
  onLinkOrder,
  linking,
}: {
  conversation: InboxConversation;
  readOnly: boolean;
  onLinkOrder: (orderId: string | null) => void;
  linking?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const panel = c.customer;
  const cust = panel.customer;
  const risk = riskSummary(cust?.risk);
  const order = panel.linked_order;
  const canChange = c.can.link_order && !readOnly;
  const address = cust?.address ? [cust.address.street, cust.address.thana, cust.address.district].filter(Boolean).join(', ') : '';

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Users aria-hidden className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-body-lg font-semibold text-text-primary">{cust?.name ?? panel.contact.name}</h2>
          <p className="truncate text-caption text-text-secondary">
            {cust ? `Customer since ${sinceLabel(cust.since)} · ${cust.orders_count} ${cust.orders_count === 1 ? 'order' : 'orders'}` : c.can.view_customer ? 'Not linked to a customer' : INBOX_IDENTITY_LABELS[c.identity]}
          </p>
        </div>
      </div>

      <dl className="flex flex-col gap-2.5">
        <Row label="Phone">{formatBdPhone(cust?.phone ?? panel.contact.phone) || '—'}</Row>
        <Row label="Email">{cust?.email ?? panel.contact.email ?? '—'}</Row>
        {cust && <Row label="Address">{address || '—'}</Row>}
      </dl>

      {risk && (
        <p className={cn('flex items-start gap-2 rounded-lg px-3 py-2.5 text-caption text-text-primary', RISK_BOX[risk.tone])}>
          <Shield aria-hidden className="mt-px size-4 shrink-0 text-text-secondary" />
          {risk.text}
        </p>
      )}

      {c.can.view_order && (
        <section aria-label="Linked order" className="flex flex-col gap-2.5">
          <div className="flex items-center">
            <h3 className="flex-1 text-body font-semibold text-text-primary">Linked order</h3>
            {canChange && (
              <button type="button" onClick={() => setPicking(true)} className="text-caption font-medium text-brand-600 hover:underline">
                {order ? 'Change' : 'Link an order'}
              </button>
            )}
          </div>
          {order ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border-default p-3">
              <div className="flex items-center gap-2">
                <span className="text-body font-semibold text-text-primary">{order.number}</span>
                <span className="flex-1 text-caption text-text-muted">{dayTime(order.placed_at)}</span>
                <PaymentStatusBadge status={order.payment_status} />
              </div>
              {order.first_line && (
                <div className="flex items-center gap-3">
                  {order.first_line.image_url ? (
                    <img src={order.first_line.image_url} alt="" className="size-9 shrink-0 rounded-md object-cover" />
                  ) : (
                    <span aria-hidden className="size-9 shrink-0 rounded-md bg-surface-subtle" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-medium text-text-primary">{order.first_line.name}</span>
                    <span className="truncate text-caption text-text-secondary">
                      {order.first_line.variant ?? ''}
                      {order.extra_lines > 0 && `${order.first_line.variant ? ' · ' : ''}+${order.extra_lines} more`}
                    </span>
                  </span>
                  <span className="text-body text-text-primary">× {order.first_line.quantity}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="flex-1 text-caption text-text-secondary">
                  {order.paid_amount > 0 && `${formatBdt(order.paid_amount)} paid`}
                  {order.paid_amount > 0 && order.due_amount > 0 && ' · '}
                  {order.due_amount > 0 && `${formatBdt(order.due_amount)} to collect`}
                </span>
                <span className="text-body font-semibold text-text-primary">{formatBdt(order.total_amount)}</span>
              </div>
              <Link to={`/orders/${order.id}`} className={buttonVariants({ variant: 'secondary', size: 'sm', fullWidth: true })}>
                View order
              </Link>
            </div>
          ) : (
            <p className="text-caption text-text-secondary">No order linked.</p>
          )}
        </section>
      )}

      {c.can.view_order && panel.past_orders.length > 0 && (
        <section aria-label="Past orders" className="flex flex-col gap-2">
          <h3 className="text-body font-semibold text-text-primary">Past orders</h3>
          <ul className="flex flex-col gap-2">
            {panel.past_orders.map((o) => (
              <li key={o.id} className="flex items-center gap-2 text-body">
                <Link to={`/orders/${o.id}`} className="font-medium text-brand-600 hover:underline">
                  {o.number}
                </Link>
                <span className="flex-1 text-caption text-text-muted">{shortDate(o.placed_at)}</span>
                <span className="text-text-primary">{formatBdt(o.total_amount)}</span>
                <OrderStatusBadge status={o.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Conversation" className="flex flex-col gap-2.5 border-t border-border-default pt-4">
        <h3 className="text-body font-semibold text-text-primary">Conversation</h3>
        <dl className="flex flex-col gap-2">
          <Row label="Channel">{INBOX_CHANNEL_LABELS[c.channel]}</Row>
          <Row label="Started">{dayTime(c.started_at)}</Row>
          <Row label="First reply">{durationLabel(c.first_response_seconds)}</Row>
          <Row label="Customer">{INBOX_IDENTITY_LABELS[c.identity]}</Row>
        </dl>
      </section>

      {c.can.view_customer && cust && (
        <Link to={`/customers/${cust.id}`} className={buttonVariants({ variant: 'secondary', fullWidth: true })}>
          View customer
        </Link>
      )}

      {picking && (
        <LinkOrderDialog
          current={order?.id ?? null}
          busy={linking}
          onClose={() => setPicking(false)}
          onPick={(id) => {
            onLinkOrder(id);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

function LinkOrderDialog({ current, busy, onClose, onPick }: { current: string | null; busy?: boolean; onClose: () => void; onPick: (id: string | null) => void }) {
  const [q, setQ] = useState('');
  const search = useOrderSearch(q.trim(), true);
  const rows = search.data?.data ?? [];
  return (
    <Dialog
      open
      title="Link an order"
      description="The linked order shows beside the conversation and fills order merge tags in saved replies."
      confirmLabel="Unlink order"
      confirmDisabled={!current}
      tone="danger"
      loading={busy}
      onConfirm={() => onPick(null)}
      onCancel={onClose}
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2.5">
          <Search aria-hidden className="size-4 text-text-muted" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order number or phone" aria-label="Search orders" className="min-w-0 flex-1 bg-transparent text-body outline-none" />
        </label>
        {search.isPending && (
          <div className="flex justify-center py-4">
            <Spinner className="size-5" />
          </div>
        )}
        <ul className="flex flex-col">
          {rows.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => onPick(o.id)}
                disabled={o.id === current}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-body hover:bg-surface-subtle disabled:opacity-60"
              >
                <span className="font-medium text-text-primary">{o.number}</span>
                <span className="min-w-0 flex-1 truncate text-caption text-text-secondary">{o.customer.name}</span>
                <span className="text-text-primary">{formatBdt(o.total_amount)}</span>
              </button>
            </li>
          ))}
          {search.isSuccess && rows.length === 0 && <li className="px-2 py-2 text-caption text-text-secondary">No orders match.</li>}
        </ul>
      </div>
    </Dialog>
  );
}
