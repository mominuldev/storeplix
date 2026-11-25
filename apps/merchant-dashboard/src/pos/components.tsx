import type { PosReceipt, PosSession } from '@storeplix/types';
import { formatBdPhone } from '../lib/phone';
import { removePrintStyle } from './print';
import { buttonVariants, cn, formatBdt, formatCount } from '@storeplix/ui';
import { Lock } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { denominationsFor, denominationTone, methodRows, parseCount, receiptLabel, receiptMethodLabel, receiptTime, vatLabel } from './pos';

// Shared POS pieces (PHASE-8-8D §11): POS bar 22:1740, denomination table 25:581 / 25:829, plan note (8.4 pattern
// 144:41323), 80 mm receipt (22:2241 preview, P88D-11) and Z-report (§11.8).

/** POS bar 22:1740: Body/16 Medium title, Caption/12 secondary line, actions on the right. */
export function PosBar({ subtitle, children }: { subtitle: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border-default bg-surface-card px-4 py-3 lg:px-6">
      <div className="flex min-w-0 flex-1 flex-col gap-px max-sm:basis-full">
        <h1 className="text-body-lg font-medium text-text-primary">Point of sale</h1>
        <p className="truncate text-caption text-text-secondary" data-testid="pos-bar-subtitle">
          {subtitle}
        </p>
      </div>
      {children}
    </header>
  );
}

/** P88D-21 pill: "● Online" success / "● Offline — reconnect to charge" danger. */
export function OnlinePill({ online }: { online: boolean }) {
  return (
    <span
      role="status"
      data-testid="pos-online-pill"
      className={cn('rounded-full px-2 py-0.5 text-caption font-medium whitespace-nowrap', online ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger')}
    >
      ● {online ? 'Online' : 'Offline — reconnect to charge'}
    </span>
  );
}

/** §2.2 plan note (8.4 pattern 144:41323). */
export function PosPlanNote({ canSeePlans }: { canSeePlans: boolean }) {
  return (
    <div role="note" data-testid="pos-plan-note" className="flex flex-wrap items-center gap-2.5 rounded-lg bg-brand-50 px-4 py-3">
      <Lock aria-hidden className="size-4 shrink-0 text-brand-600" />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">POS is on the Growth plan. Upgrade to sell at the till from your shop’s stock.</p>
      {canSeePlans && (
        <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          See plans
        </Link>
      )}
    </div>
  );
}

const chipTone = {
  success: 'bg-success-bg text-success',
  info: 'bg-info-bg text-info',
  accent: 'bg-accent-100 text-accent-500',
} as const;

/**
 * NOTE / COIN · COUNT · AMOUNT table (P88D-15 list). `counts` holds the raw input text per denomination so a bad entry
 * can be flagged; non-BDT stores get one amount field instead (rendered by the caller).
 */
export function DenominationTable({ currency, texts, onChange }: { currency: string; texts: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const rows = denominationsFor(currency) ?? [];
  return (
    <table className="w-full border-collapse text-left" data-testid="pos-denominations">
      <thead>
        <tr className="border-b border-border-default text-caption text-text-secondary uppercase">
          <th scope="col" className="py-2 font-normal">
            Note / coin
          </th>
          <th scope="col" className="w-24 py-2 font-normal sm:w-32">
            Count
          </th>
          <th scope="col" className="w-24 py-2 text-right font-normal">
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const key = String(r.value);
          const text = texts[key] ?? '';
          const count = parseCount(text);
          const amount = count === null ? null : count * r.value;
          return (
            <tr key={key} className="border-b border-border-default">
              <td className="py-2">
                <span className="flex items-center gap-2.5">
                  <span className={cn('min-w-[50px] rounded-sm px-1.5 py-1 text-center text-caption font-medium', chipTone[denominationTone(r.value)])}>{formatBdt(r.value)}</span>
                  <span className="text-caption text-text-muted">{r.kind}</span>
                </span>
              </td>
              <td className="py-2">
                <input
                  inputMode="numeric"
                  aria-label={`Count of ${formatBdt(r.value)}`}
                  aria-invalid={count === null || undefined}
                  value={text}
                  placeholder="0"
                  onChange={(e) => onChange({ ...texts, [key]: e.target.value })}
                  className={cn(
                    'h-8 w-full rounded-md border bg-surface-card text-center text-body text-text-primary outline-none placeholder:text-text-muted focus-visible:border-brand-600 focus-visible:shadow-focus',
                    count === null ? 'border-danger' : text && count ? 'border-border-strong' : 'border-border-default',
                  )}
                />
              </td>
              <td className={cn('py-2 text-right text-body', amount ? 'font-medium text-text-primary' : 'text-text-muted')}>{amount === null ? '—' : formatBdt(amount)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Label · value row used by the side cards. */
export function Row({ label, value, strong, tone, testId }: { label: ReactNode; value: ReactNode; strong?: boolean; tone?: 'success' | 'danger'; testId?: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className={cn('flex-1 text-body', strong ? 'font-semibold text-text-primary' : 'text-text-secondary')}>{label}</span>
      <span
        data-testid={testId}
        className={cn('text-body', strong ? 'font-semibold' : 'font-medium', tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-text-primary')}
      >
        {value}
      </span>
    </div>
  );
}

export function SideCard({ title, children, aside, className }: { title: ReactNode; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 lg:p-6', className)}>
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-body-lg font-medium text-text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ---------- Printing (P88D-11) ----------
/** Off-screen print root (portal on <body>); only visible while `body.pos-printing` prints. */
export function PrintArea({ children }: { children: ReactNode }) {
  useEffect(() => () => removePrintStyle(), []);
  if (typeof document === 'undefined') return null;
  return createPortal(<div className="pos-print-root">{children}</div>, document.body);
}

/** 80 mm receipt (Figma 22:2241 preview): header, BIN, lines, totals, VAT, payments, change, footer. */
export function ReceiptView({ receipt, className }: { receipt: PosReceipt; className?: string }) {
  const l = (k: Parameters<typeof receiptLabel>[1]) => receiptLabel(receipt.language, k);
  const vat = vatLabel(receipt.language, receipt.vat);
  return (
    <article
      data-testid="pos-receipt"
      lang={receipt.language}
      className={cn('flex w-full max-w-[302px] flex-col gap-2 bg-surface-card p-5 text-caption text-text-primary', className)}
    >
      <header className="flex flex-col items-center gap-1 text-center">
        {receipt.shop.logo_url && <img src={receipt.shop.logo_url} alt="" className="max-h-10 max-w-[160px] object-contain" />}
        <p className="text-body-lg font-medium uppercase">{receipt.shop.name}</p>
        {receipt.shop.address && <p className="text-text-secondary">{receipt.shop.address}</p>}
        {(receipt.shop.phone || receipt.shop.bin) && (
          <p className="text-text-secondary">{[receipt.shop.phone, receipt.shop.bin ? `${l('bin')} ${receipt.shop.bin}` : null].filter(Boolean).join(' · ')}</p>
        )}
      </header>
      <div className="flex flex-col gap-1 border-t border-border-default pt-2">
        <div className="flex justify-between gap-2">
          <span>
            {l('receipt')} {receipt.number}
          </span>
          <span>{receiptTime(receipt.placed_at)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>
            {l('cashier')}: {receipt.cashier_name}
          </span>
          <span>{receipt.register_name}</span>
        </div>
        {receipt.customer && (
          <div className="flex justify-between gap-2">
            <span>{l('customer')}</span>
            <span>{[receipt.customer.name, receipt.customer.phone ? formatBdPhone(receipt.customer.phone) : null].filter(Boolean).join(' · ')}</span>
          </div>
        )}
      </div>
      <ul className="flex flex-col gap-1 border-t border-border-default pt-2">
        {receipt.lines.map((line, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span>
              {line.name}
              {line.variant_title ? ` (${line.variant_title})` : ''} ×{formatCount(line.quantity)}
            </span>
            <span className="whitespace-nowrap">{formatBdt(line.line_total_amount)}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1 border-t border-border-default pt-2">
        <div className="flex justify-between">
          <span>{l('subtotal')}</span>
          <span>{formatBdt(receipt.subtotal_amount)}</span>
        </div>
        {receipt.discount_amount > 0 && (
          <div className="flex justify-between text-success">
            <span>
              {l('discount')} {receipt.coupon_code ?? ''}
            </span>
            <span>− {formatBdt(receipt.discount_amount)}</span>
          </div>
        )}
        {vat && receipt.vat && (
          <div className="flex justify-between">
            <span>{vat}</span>
            <span>{formatBdt(receipt.vat.amount)}</span>
          </div>
        )}
        <div className="flex justify-between text-body font-semibold">
          <span>{l('total')}</span>
          <span data-testid="pos-receipt-total">{formatBdt(receipt.total_amount)}</span>
        </div>
        {receipt.payments.map((p, i) => (
          <div key={i} className="flex justify-between">
            <span>{receiptMethodLabel(receipt.language, p.method)}</span>
            <span>{formatBdt(p.method === 'cash' && receipt.tendered_cash_amount !== null && receipt.payments.length === 1 ? receipt.tendered_cash_amount : p.amount)}</span>
          </div>
        ))}
        {receipt.change_amount > 0 && (
          <div className="flex justify-between">
            <span>{l('change')}</span>
            <span>{formatBdt(receipt.change_amount)}</span>
          </div>
        )}
      </div>
      {receipt.footer_text && <p className="border-t border-border-default pt-2 text-center text-text-secondary whitespace-pre-line">{receipt.footer_text}</p>}
    </article>
  );
}

/** §11.8 Z-report: the closed (or closing) session's totals on one 80 mm page. */
export function ZReportView({ session, shopName }: { session: PosSession; shopName: string }) {
  const t = session.totals;
  const line = (label: string, value: ReactNode) => (
    <div key={label} className="flex justify-between gap-2">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
  return (
    <article data-testid="pos-z-report" className="flex w-full max-w-[302px] flex-col gap-2 bg-surface-card p-5 text-caption text-text-primary">
      <header className="flex flex-col items-center gap-1 text-center">
        <p className="text-body-lg font-medium uppercase">{shopName}</p>
        <p>Z-report · {session.register.name}</p>
        <p className="text-text-secondary">{session.register.location.name}</p>
      </header>
      <div className="flex flex-col gap-1 border-t border-border-default pt-2">
        {line('Opened', `${receiptTime(session.opened_at)} · ${session.opened_by.name}`)}
        {session.closed_at && line('Closed', `${receiptTime(session.closed_at)}${session.closed_by ? ` · ${session.closed_by.name}` : ''}`)}
      </div>
      <div className="flex flex-col gap-1 border-t border-border-default pt-2">
        {line('Receipts', formatCount(t.receipts_count))}
        {methodRows(session).map((m) => line(m.label, formatBdt(m.amount)))}
        {line('Returns', `${formatCount(t.returns_count)} · ${formatBdt(t.returns_amount)}`)}
        {line('Discounts given', formatBdt(t.discounts_amount))}
        <div className="flex justify-between font-semibold">
          <span>Total sales</span>
          <span>{formatBdt(t.sales_amount)}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1 border-t border-border-default pt-2">
        {line('Opening cash', formatBdt(session.opening_cash_amount))}
        {line('+ Cash sales', formatBdt(t.cash_sales_amount))}
        {line('− Cash refunds', formatBdt(t.cash_refunds_amount))}
        {line('Expected in drawer', formatBdt(session.expected_cash_amount ?? t.cash_in_drawer_amount))}
        {session.counted_cash_amount !== null && line('Counted', formatBdt(session.counted_cash_amount))}
        {session.variance_amount !== null && line('Variance', formatBdt(session.variance_amount))}
        {session.left_in_drawer_amount !== null && line('Left in drawer', formatBdt(session.left_in_drawer_amount))}
        {session.banked_amount !== null && line('Banked', formatBdt(session.banked_amount))}
        {session.close_note && line('Note', session.close_note)}
      </div>
    </article>
  );
}
