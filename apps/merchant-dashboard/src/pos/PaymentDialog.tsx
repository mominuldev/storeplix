import { POS_PAYMENT_METHOD_LABELS, POS_PAYMENT_REFERENCE_MAX, POS_PAYMENTS_MAX, type PosPaymentMethod } from '@storeplix/types';
import { Button, Checkbox, cn, formatBdt, Modal, moneyToInput, parseMoney } from '@storeplix/ui';
import { Delete, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { buildTender, changeBreakdown, numpadNext, quickCash, splitRemaining, tenderCards, type SplitPart, type TenderMode, type TenderResult, type TenderState } from './pos';

// PHASE-8-8D §11.4 Payment 22:2073: "Take payment" + "{customer} · n items · {register}"; Amount to pay + subtotal /
// discount; method cards Cash (Drawer) / bKash (QR or number) / Card (POS terminal) / Split (Mix methods). Cash: "Cash
// received" input, Exact + next round notes, numpad, "Change to give" + the greedy note breakdown. bKash / Card: optional
// reference (composed). Split: method + amount rows, remaining shown, ≤ 4 (composed). Ticks Print receipt, SMS receipt.
// Hidden: "Open drawer" (Q240). Complete is disabled while offline (P88D-21).

export interface PaymentSubmit {
  tender: Extract<TenderResult, { ok: true }>;
  print: boolean;
  sms: boolean;
}

export interface PaymentDialogProps {
  total: number;
  subtotal: number;
  discount: number;
  couponCode: string | null;
  subtitle: string;
  hasPhone: boolean;
  initialMode: TenderMode;
  initialCash: number | null;
  online: boolean;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (s: PaymentSubmit) => void;
}

const methods: PosPaymentMethod[] = ['cash', 'bkash_personal', 'card'];

export function PaymentDialog({
  total,
  subtotal,
  discount,
  couponCode,
  subtitle,
  hasPhone,
  initialMode,
  initialCash,
  online,
  pending,
  error,
  onClose,
  onSubmit,
}: PaymentDialogProps) {
  const [mode, setMode] = useState<TenderMode>(initialMode);
  const [cashText, setCashText] = useState(() => moneyToInput(initialCash ?? total));
  const [reference, setReference] = useState('');
  const [parts, setParts] = useState<SplitPart[]>([
    { method: 'cash', amount: null, reference: '' },
    { method: 'bkash_personal', amount: null, reference: '' },
  ]);
  const [print, setPrint] = useState(true);
  const [sms, setSms] = useState(hasPhone);

  const cash = parseMoney(cashText);
  const state: TenderState = {
    mode,
    cashReceived: cash === null || Number.isNaN(cash) ? Number.NaN : cash,
    reference,
    parts,
  };
  const result = buildTender(total, state);
  const change = result.ok ? result.change : 0;
  const remaining = splitRemaining(total, parts);
  const canSubmit = result.ok && online && !pending;

  const setPart = (i: number, patch: Partial<SplitPart>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Modal
      open
      onClose={onClose}
      title="Take payment"
      description={subtitle}
      size="xl"
      className="max-md:h-dvh max-md:max-h-dvh max-md:w-full max-md:max-w-none max-md:rounded-none"
    >
      <div className="flex flex-col gap-4" data-testid="pos-payment">
        <div className="flex items-end gap-3 rounded-lg bg-surface-canvas px-5 py-4">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-body text-text-secondary">Amount to pay</span>
            <span className="text-[40px] leading-[48px] font-bold text-text-primary" data-testid="pos-amount-to-pay">
              {formatBdt(total)}
            </span>
          </div>
          <div className="flex flex-col items-end text-caption">
            <span className="text-text-secondary">Subtotal {formatBdt(subtotal)}</span>
            {discount > 0 && (
              <span className="text-success">
                {couponCode ?? 'Discount'} − {formatBdt(discount)}
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Payment method">
          {tenderCards.map((c) => (
            <button
              key={c.mode}
              type="button"
              role="radio"
              aria-checked={mode === c.mode}
              onClick={() => setMode(c.mode)}
              className={cn(
                'flex flex-col items-center rounded-lg border py-3 outline-none focus-visible:shadow-focus',
                mode === c.mode ? 'border-2 border-brand-600 bg-brand-50 text-brand-700' : 'border-border-default bg-surface-card text-text-primary hover:bg-surface-subtle',
              )}
            >
              <span className="text-body-lg">{c.label}</span>
              <span className="text-caption text-text-muted">{c.hint}</span>
            </button>
          ))}
        </div>

        {mode === 'cash' && (
          <div className="flex flex-col gap-4 md:flex-row">
            <div className="flex flex-1 flex-col gap-3">
              <label className="flex flex-col gap-2">
                <span className="text-body font-medium text-text-primary">Cash received</span>
                <input
                  inputMode="decimal"
                  value={cashText}
                  onChange={(e) => setCashText(e.target.value)}
                  aria-invalid={!result.ok || undefined}
                  data-testid="pos-cash-received"
                  className="h-14 rounded-lg border-2 border-brand-600 bg-surface-card px-4 text-heading-24 text-text-primary outline-none focus-visible:shadow-focus"
                />
              </label>
              <div className="grid grid-cols-4 gap-2">
                <QuickChip active={cash === total} onClick={() => setCashText(moneyToInput(total))}>
                  Exact
                </QuickChip>
                {quickCash(total, 3).map((v) => (
                  <QuickChip key={v} active={cash === v} onClick={() => setCashText(moneyToInput(v))}>
                    {formatBdt(v)}
                  </QuickChip>
                ))}
              </div>
              {result.ok ? (
                <div className="flex items-end gap-3 rounded-lg bg-success-bg px-4 py-3" data-testid="pos-change">
                  <div className="flex flex-col">
                    <span className="text-body text-success">Change to give</span>
                    <span className="text-heading-32 text-success">{formatBdt(change)}</span>
                  </div>
                  {change > 0 && <span className="ml-auto text-caption text-success">Give {changeBreakdown(change)}</span>}
                </div>
              ) : (
                <p className="rounded-lg bg-danger-bg px-4 py-3 text-body text-danger" role="alert">
                  {result.error}
                </p>
              )}
            </div>
            <Numpad onKey={(k) => setCashText(numpadNext((cashText.split('.')[0] ?? '').replace(/\D/g, ''), k))} />
          </div>
        )}

        {(mode === 'bkash_personal' || mode === 'card') && (
          <label className="flex flex-col gap-2">
            <span className="text-body font-medium text-text-primary">{mode === 'card' ? 'Approval code (optional)' : 'TrxID (optional)'}</span>
            <input
              value={reference}
              maxLength={POS_PAYMENT_REFERENCE_MAX}
              onChange={(e) => setReference(e.target.value)}
              data-testid="pos-reference"
              className="h-11 rounded-md border border-border-default bg-surface-card px-3 text-body outline-none focus-visible:border-brand-600 focus-visible:shadow-focus"
            />
            <span className="text-caption text-text-muted">
              {mode === 'card' ? 'Take the card on your own terminal, then record the sale here.' : 'Check the bKash message on your phone before completing.'}
            </span>
          </label>
        )}

        {mode === 'split' && (
          <div className="flex flex-col gap-2" data-testid="pos-split">
            {parts.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select
                  aria-label={`Part ${i + 1} method`}
                  value={p.method}
                  onChange={(e) => setPart(i, { method: e.target.value as PosPaymentMethod })}
                  className="h-11 rounded-md border border-border-default bg-surface-card px-3 text-body outline-none focus-visible:border-brand-600"
                >
                  {methods.map((m) => (
                    <option key={m} value={m}>
                      {POS_PAYMENT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
                <input
                  inputMode="decimal"
                  aria-label={`Part ${i + 1} amount`}
                  placeholder="৳ 0"
                  value={p.amount === null ? '' : moneyToInput(p.amount)}
                  onChange={(e) => {
                    const v = parseMoney(e.target.value);
                    setPart(i, {
                      amount: v === null || Number.isNaN(v) ? null : v,
                    });
                  }}
                  className="h-11 w-32 rounded-md border border-border-default bg-surface-card px-3 text-body outline-none focus-visible:border-brand-600"
                />
                {p.method !== 'cash' && (
                  <input
                    aria-label={`Part ${i + 1} reference`}
                    placeholder={p.method === 'card' ? 'Approval code (optional)' : 'TrxID (optional)'}
                    maxLength={POS_PAYMENT_REFERENCE_MAX}
                    value={p.reference}
                    onChange={(e) => setPart(i, { reference: e.target.value })}
                    className="h-11 min-w-0 flex-1 rounded-md border border-border-default bg-surface-card px-3 text-body outline-none focus-visible:border-brand-600"
                  />
                )}
                {remaining > 0 && p.amount === null && (
                  <Button size="sm" variant="ghost" onClick={() => setPart(i, { amount: remaining })}>
                    Rest
                  </Button>
                )}
                {parts.length > 2 && (
                  <button
                    type="button"
                    aria-label={`Remove part ${i + 1}`}
                    className="flex size-9 items-center justify-center rounded-md text-text-muted hover:bg-surface-subtle"
                    onClick={() => setParts(parts.filter((_, j) => j !== i))}
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                )}
              </div>
            ))}
            <div className="flex items-center gap-3">
              {parts.length < POS_PAYMENTS_MAX && (
                <Button size="sm" variant="ghost" onClick={() => setParts([...parts, { method: 'card', amount: null, reference: '' }])}>
                  <Plus aria-hidden className="size-3.5" /> Add payment
                </Button>
              )}
              <span className={cn('ml-auto text-body font-medium', remaining === 0 ? 'text-success' : 'text-danger')} data-testid="pos-split-remaining">
                {remaining === 0 ? 'Fully paid' : remaining > 0 ? `Remaining ${formatBdt(remaining)}` : `Over by ${formatBdt(-remaining)}`}
              </span>
            </div>
            {!result.ok && remaining === 0 && (
              <p className="text-body text-danger" role="alert">
                {result.error}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-5">
          <Checkbox label="Print receipt" checked={print} onChange={(e) => setPrint(e.target.checked)} />
          <Checkbox label="SMS receipt" checked={sms && hasPhone} disabled={!hasPhone} onChange={(e) => setSms(e.target.checked)} />
        </div>
        {!online && (
          <p className="rounded-lg bg-danger-bg px-4 py-3 text-body text-danger" role="alert">
            You’re offline. Reconnect to complete the sale.
          </p>
        )}
        {error && (
          <p className="rounded-lg bg-danger-bg px-4 py-3 text-body text-danger" role="alert" data-testid="pos-payment-error">
            {error}
          </p>
        )}
        <Button
          className="min-h-14 text-heading"
          disabled={!canSubmit}
          data-testid="pos-complete-sale"
          onClick={() => result.ok && onSubmit({ tender: result, print, sms: sms && hasPhone })}
        >
          {pending ? 'Completing…' : `Complete sale · ${formatBdt(total)}`}
        </Button>
      </div>
    </Modal>
  );
}

function QuickChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-h-10 rounded-md text-body font-medium outline-none focus-visible:shadow-focus',
        active ? 'bg-brand-50 text-brand-700' : 'bg-surface-subtle text-text-primary hover:bg-border-default',
      )}
    >
      {children}
    </button>
  );
}

const keysPad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];

function Numpad({ onKey }: { onKey: (key: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2 md:w-[252px]" aria-label="Numpad">
      {keysPad.map((k) => (
        <button
          key={k}
          type="button"
          aria-label={k === 'back' ? 'Backspace' : k}
          onClick={() => onKey(k)}
          className="flex h-14 items-center justify-center rounded-lg bg-surface-subtle text-heading text-text-primary hover:bg-border-default"
        >
          {k === 'back' ? <Delete aria-hidden className="size-5" /> : k}
        </button>
      ))}
    </div>
  );
}
