import type { BlockedNumber, FraudGuardEvent } from '@storeplix/types';
import { Badge, Button, buttonVariants, cn, Dialog } from '@storeplix/ui';
import { AlertTriangle, Check, CreditCard, Lock, MessageSquare, Phone, ShieldCheck, ShoppingBag, Unlock } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../catalog/states';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { toast } from '../online-store/components/Toast';
import { blockedBy, blockReason, displayPhone, eventMeta, eventText, eventTime, longDate, type EventIcon } from './fraud';
import { useBlockMutations } from './queries';

// Shared pieces of the guard page (39:11233) and its composed "View all" pages: blocked numbers table 41:11630
// (cards below md), decision rows 41:11740, privacy note 41:11808, plan note (§10.5).

export function GuardCard({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <section aria-label={label} className={cn('flex min-w-0 flex-col rounded-card border border-border-default bg-surface-card shadow-elevation-1', className)}>
      {children}
    </section>
  );
}

/** §10.5 Free plan: "Fake order guard is on Starter and Growth." + "See plans". */
export function GuardPlanNote({ canSeePlans }: { canSeePlans: boolean }) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-2.5 rounded-lg bg-brand-50 px-4 py-3">
      <Lock aria-hidden className="size-4 shrink-0 text-brand-600" />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">Fake order guard is on Starter and Growth. Risk badges and your shop’s delivery record still show on every order.</p>
      {canSeePlans && (
        <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          See plans
        </Link>
      )}
    </div>
  );
}

/** 41:11808 "Your data stays yours" (copy adapted to own-shop data only, Q189). */
export function PrivacyNote() {
  return (
    <aside aria-label="Your data stays yours" className="flex flex-col gap-2 rounded-card border border-brand-100 bg-brand-50 p-5">
      <p className="flex items-center gap-2 text-body font-medium text-brand-700">
        <ShieldCheck aria-hidden className="size-4" /> Your data stays yours
      </p>
      <p className="text-caption text-text-secondary">
        Records come only from your shop’s own orders. Nothing is shared with other Storeplix shops or couriers, and buyers’ numbers are never sold. Your privacy policy mentions these checks.
      </p>
      {/* Q189 help anchor: no help centre exists yet, so the explanation opens in place (never a fake link). */}
      <details id="how-checks-work" className="text-caption text-text-secondary [&[open]>summary]:mb-1.5">
        <summary className="cursor-pointer font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">Read how checks work</summary>
        Every new order is checked against this number’s parcels at your shop: delivered versus returned. A number with only a few parcels gets
        no verdict yet; below your hold line the order waits for a call; below your advance line we ask for the delivery charge first.
        You can release or confirm any order yourself.
      </details>
    </aside>
  );
}

const icons: Record<EventIcon, ReactNode> = {
  phone: <Phone aria-hidden />,
  card: <CreditCard aria-hidden />,
  check: <Check aria-hidden />,
  alert: <AlertTriangle aria-hidden />,
  orders: <ShoppingBag aria-hidden />,
  unlock: <Unlock aria-hidden />,
  sms: <MessageSquare aria-hidden />,
};
const tileTone: Record<string, string> = {
  warning: 'bg-warning-bg text-warning',
  brand: 'bg-brand-50 text-brand-600',
  success: 'bg-success-bg text-success',
  danger: 'bg-danger-bg text-danger',
  neutral: 'bg-surface-subtle text-text-secondary',
  info: 'bg-info-bg text-info',
};

/** One decision row (41:11744): icon tile, Tag + time, order / number, detail line. */
export function DecisionRow({ event }: { event: FraudGuardEvent }) {
  const meta = eventMeta[event.type];
  const text = eventText(event);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-[9px] [&_svg]:size-4', tileTone[meta.tone])}>{icons[meta.icon]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <Badge size="sm" tone={meta.tone}>
            {meta.label}
          </Badge>
          <span className="min-w-0 flex-1 text-right text-caption text-text-muted">{eventTime(event.created_at)}</span>
        </div>
        {event.order ? (
          <Link to={`/orders/${event.order.id}`} className="truncate text-body font-semibold text-text-primary hover:text-brand-600">
            {text.title}
          </Link>
        ) : (
          <span className="truncate text-body font-semibold text-text-primary">{text.title}</span>
        )}
        <span className="text-caption text-text-secondary">{text.detail}</span>
      </div>
    </li>
  );
}

export function DecisionList({ events }: { events: FraudGuardEvent[] }) {
  return (
    <ul aria-label="Decisions" className="flex flex-col divide-y divide-border-default">
      {events.map((e) => (
        <DecisionRow key={e.id} event={e} />
      ))}
    </ul>
  );
}

/** Unblock with a confirm (DELETE → 204; the return rule never re-adds the number, P88-10). */
function useUnblock() {
  const { unblock } = useBlockMutations();
  const [target, setTarget] = useState<BlockedNumber | null>(null);
  const dialog = (
    <Dialog
      open={!!target}
      title={target ? `Unblock ${displayPhone(target)}?` : 'Unblock'}
      description="Cash on delivery turns back on for this number. The return rule won’t block it again."
      confirmLabel="Unblock"
      loading={unblock.isPending}
      onCancel={() => setTarget(null)}
      onConfirm={() =>
        target &&
        unblock.mutate(target.id, {
          onSuccess: () => {
            toast(`${displayPhone(target)} unblocked.`);
            setTarget(null);
          },
          onError: (e) => {
            setTarget(null);
            toast(errorMessage(e, 'We couldn’t unblock this number.'), 'error');
          },
        })
      }
    />
  );
  return { ask: setTarget, dialog };
}

/** Blocked numbers table (41:11630): NUMBER, REASON, BLOCKED BY, DATE, Unblock; cards below md. */
export function BlockedTable({ rows, canWrite, dim }: { rows: BlockedNumber[]; canWrite: boolean; dim?: boolean }) {
  const unblock = useUnblock();
  const action = (b: BlockedNumber) =>
    canWrite ? (
      <ReadOnlyActions>
        <Button size="sm" variant="ghost" className="px-0" onClick={() => unblock.ask(b)} aria-label={`Unblock ${displayPhone(b)}`}>
          Unblock
        </Button>
      </ReadOnlyActions>
    ) : null;
  return (
    <>
      <table aria-label="Blocked numbers" className={cn('w-full table-fixed text-body max-md:hidden', dim && 'opacity-60')}>
        <thead className="text-caption font-medium text-text-muted uppercase">
          <tr className="border-y border-border-default">
            <th scope="col" className="w-[24%] py-2.5 pl-5 text-left font-medium">
              Number
            </th>
            <th scope="col" className="px-3 py-2.5 text-left font-medium">
              Reason
            </th>
            <th scope="col" className="w-[22%] px-3 py-2.5 text-left font-medium">
              Blocked by
            </th>
            <th scope="col" className="w-[16%] px-3 py-2.5 text-left font-medium">
              Date
            </th>
            <th scope="col" className="w-[88px] py-2.5 pr-5 text-right font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const r = blockReason(b);
            const by = blockedBy(b);
            return (
              <tr key={b.id} className="border-b border-border-default last:border-b-0">
                <td className="py-3.5 pl-5 align-middle">
                  <span className="block truncate font-medium text-text-primary">{displayPhone(b)}</span>
                  <span className="block truncate text-caption text-text-muted">
                    {b.customer ? (
                      <Link to={`/customers/${b.customer.id}`} className="hover:text-brand-600">
                        {b.customer.name}
                      </Link>
                    ) : (
                      'No name given'
                    )}
                  </span>
                </td>
                <td className="px-3 py-3.5 align-middle">
                  <span className="block text-text-primary">{r.title}</span>
                  {r.detail && <span className="block text-caption text-text-muted">{r.detail}</span>}
                </td>
                <td className="px-3 py-3.5 align-middle">
                  <span className="flex flex-wrap items-center gap-1.5 text-caption text-text-secondary">
                    <Badge size="sm" tone={b.source === 'auto' ? 'neutral' : 'brand'}>
                      {by.who}
                    </Badge>
                    {by.role}
                  </span>
                </td>
                <td className="px-3 py-3.5 align-middle whitespace-nowrap text-text-secondary">{longDate(b.created_at)}</td>
                <td className="py-3.5 pr-5 text-right align-middle">{action(b)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul aria-label="Blocked numbers" className={cn('flex flex-col divide-y divide-border-default border-t border-border-default md:hidden', dim && 'opacity-60')}>
        {rows.map((b) => {
          const r = blockReason(b);
          const by = blockedBy(b);
          return (
            <li key={b.id} className="flex flex-col gap-1 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-body font-medium text-text-primary">{displayPhone(b)}</span>
                {action(b)}
              </div>
              <span className="text-caption text-text-muted">{b.customer?.name ?? 'No name given'}</span>
              <span className="text-body text-text-primary">{r.title}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-caption text-text-secondary">
                <Badge size="sm" tone={b.source === 'auto' ? 'neutral' : 'brand'}>
                  {by.who}
                </Badge>
                {by.role} · {longDate(b.created_at)}
              </span>
            </li>
          );
        })}
      </ul>
      {unblock.dialog}
    </>
  );
}
