import { zodResolver } from '@hookform/resolvers/zod';
import { POS_CLOSE_NOTE_MAX, type PosSession } from '@storeplix/types';
import { Button, cn, formatBdt, formatCount, Input, Modal, moneyToInput, parseMoney } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows } from '../catalog/states';
import { newIdempotencyKey } from '../commerce/format';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { DenominationTable, PosBar, PrintArea, Row, SideCard, ZReportView } from './components';
import { closeNoteDetails } from './errors';
import { bankedAmount, countsSum, createAttemptKeys, denominationsFor, methodRows, textsToCounts, timeOf, varianceView } from './pos';
import { printPos } from './print';
import { posKeys, usePosSession } from './queries';

// PHASE-8-8D §11.8 Close register 25:829 (section 27:1028): count table (P88D-15 list) + Counted; Cash check (Opening,
// + Cash sales, − Cash refunds, Expected, Counted, Short / Over / Matches banner with the ৳ 50 tolerance copy, Note
// optional / required); "Leave in drawer" + "Banked ৳ x" (composed, Q245); Today's sales (receipts, Cash / bKash /
// Card, Returns, Discounts given, Total sales); held-sales warning; Print Z-report (80 mm browser print); Close
// register (confirm). After close → /pos. Expected is the server's live figure; the close response is authoritative.

const closeSchema = z.object({
  note: z.string().trim().max(POS_CLOSE_NOTE_MAX, `Up to ${POS_CLOSE_NOTE_MAX} characters`),
  left: z.string(),
});
type CloseValues = z.infer<typeof closeSchema>;

export default function ClosePage() {
  const { sessionId } = useParams();
  const session = usePosSession(sessionId);
  if (session.isPending) {
    return (
      <div className="flex flex-1 flex-col">
        <PosBar subtitle="Loading register…" />
        <div className="p-6">
          <LoadingRows rows={8} label="Loading register" />
        </div>
      </div>
    );
  }
  if (session.isError) {
    return (
      <div className="flex flex-1 flex-col">
        <PosBar subtitle="Close register" />
        <div className="p-6">
          <ErrorBlock error={session.error} title="We couldn’t load this register" onRetry={() => session.refetch()} />
        </div>
      </div>
    );
  }
  if (session.data.status === 'closed') return <Navigate to="/pos" replace />;
  return <CloseRegister session={session.data} />;
}

function CloseRegister({ session }: { session: PosSession }) {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const currency = session.currency || scope.store?.currency || 'BDT';
  const bdt = denominationsFor(currency) !== null;
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [amountText, setAmountText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const keys = useRef(createAttemptKeys(newIdempotencyKey));

  const counts = bdt ? textsToCounts(currency, texts) : null;
  const countedRaw = bdt ? (counts ? countsSum(counts) : null) : parseMoney(amountText);
  const counted = countedRaw === null || Number.isNaN(countedRaw) ? null : countedRaw;
  const t = session.totals;
  const expected = t.cash_in_drawer_amount;
  const variance = varianceView(counted ?? 0, expected, session.tolerance_amount);

  const { register, handleSubmit, control, setError, formState } = useForm<CloseValues>({
    resolver: zodResolver(closeSchema),
    defaultValues: {
      note: '',
      left: moneyToInput(session.opening_cash_amount),
    },
  });
  const noteText = useWatch({ control, name: 'note' });
  const leftText = useWatch({ control, name: 'left' });
  const leftParsed = parseMoney(leftText);
  const left = leftParsed === null ? 0 : leftParsed;
  const banked = counted === null || Number.isNaN(left) ? null : bankedAmount(counted, left);
  const noteMissing = variance.noteRequired && !noteText.trim();
  const ready = counted !== null && banked !== null && !noteMissing;

  const close = useMutation({
    mutationFn: (values: CloseValues) => {
      const input = {
        ...(bdt ? { counts: counts ?? {} } : { counted_cash_amount: counted ?? 0 }),
        left_in_drawer_amount: left,
        note: values.note.trim() || null,
        revision: session.revision,
      };
      return api.pos.sessions.close(scope.storeId!, session.id, input, keys.current.keyFor(JSON.stringify(input)));
    },
    onSuccess: (closed) => {
      keys.current.reset();
      qc.setQueryData(posKeys.session(scope, session.id), closed);
      void qc.invalidateQueries({ queryKey: posKeys.registers(scope) });
      toast(`${closed.register.name} closed. ${closed.banked_amount !== null ? `Bank ${formatBdt(closed.banked_amount)}.` : ''}`);
      navigate('/pos');
    },
    onError: (e) => {
      setConfirming(false);
      const d = closeNoteDetails(e);
      if (d) {
        setError('note', {
          message: `Add a note — the drawer is ${formatBdt(Math.abs(d.variance_amount))} ${d.variance_amount < 0 ? 'short' : 'over'}, above your ${formatBdt(
            d.tolerance_amount,
          )} tolerance.`,
        });
        return;
      }
      setServerError(errorMessage(e, 'We couldn’t close the register.'));
      if (e && typeof e === 'object' && 'code' in e && e.code === 'revision_conflict')
        void qc.invalidateQueries({
          queryKey: posKeys.session(scope, session.id),
        });
    },
  });

  const subtitle = `${session.register.name} · ${session.register.location.name} · Open since ${timeOf(session.opened_at)} · ${session.opened_by.name}`;
  const methods = methodRows(session);
  const barTotal = methods.reduce((s, m) => s + m.amount, 0);
  const barTone = {
    cash: 'bg-brand-600',
    bkash_personal: 'bg-success',
    card: 'bg-accent-500',
  } as const;

  return (
    <div className="flex flex-1 flex-col">
      <PosBar subtitle={subtitle}>
        <Link
          to={`/pos/${session.id}`}
          className="rounded-md border border-border-default bg-surface-card px-4 py-2 text-body font-semibold text-text-primary hover:bg-surface-subtle"
        >
          Back to sale
        </Link>
      </PosBar>
      <div className="flex flex-col gap-5 px-4 pt-5 pb-28 lg:px-8 lg:py-7">
        <div className="flex flex-col gap-1">
          <h2 className="text-heading-24 text-text-primary">Close register</h2>
          <p className="text-body text-text-secondary">Count the drawer, check the difference, then print the end-of-day report.</p>
        </div>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <SideCard title="Count cash in drawer" className="min-w-0 flex-1">
            {bdt ? (
              <DenominationTable currency={currency} texts={texts} onChange={setTexts} />
            ) : (
              <Input label="Counted cash" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
            )}
            <div className="flex items-center pt-2">
              <span className="flex-1 text-body-lg font-medium text-text-primary">Counted</span>
              <span className="text-heading-24 text-text-primary" data-testid="pos-counted">
                {counted === null ? '—' : formatBdt(counted)}
              </span>
            </div>
          </SideCard>

          <div className="flex w-full flex-col gap-5 lg:w-[448px]">
            <SideCard title="Cash check">
              <div className="flex flex-col gap-2">
                <Row label="Opening cash" value={formatBdt(session.opening_cash_amount)} />
                <Row label="+ Cash sales" value={formatBdt(t.cash_sales_amount)} />
                <Row label="− Cash refunds" value={formatBdt(t.cash_refunds_amount)} />
                <Row label="Expected in drawer" value={formatBdt(expected)} strong testId="pos-expected" />
                <Row label="Counted" value={counted === null ? '—' : formatBdt(counted)} strong />
              </div>
              {counted !== null && (
                <div
                  role="status"
                  data-testid="pos-variance"
                  className={cn(
                    'flex items-start gap-3 rounded-lg px-4 py-3',
                    variance.tone === 'success' ? 'bg-success-bg' : variance.tone === 'warning' ? 'bg-warning-bg' : 'bg-danger-bg',
                  )}
                >
                  {variance.tone === 'success' ? (
                    <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
                  ) : (
                    <AlertTriangle aria-hidden className={cn('mt-0.5 size-5 shrink-0', variance.tone === 'warning' ? 'text-warning' : 'text-danger')} />
                  )}
                  <div className="flex flex-col">
                    <span className={cn('text-body font-medium', variance.tone === 'success' ? 'text-success' : variance.tone === 'warning' ? 'text-warning' : 'text-danger')}>
                      {variance.label}
                    </span>
                    <span className="text-caption text-text-secondary">{variance.hint}</span>
                  </div>
                </div>
              )}
              <Input
                aria-label={variance.noteRequired ? 'Note (required)' : 'Note (optional)'}
                placeholder={variance.noteRequired ? 'Note (required)' : 'Note (optional)'}
                maxLength={POS_CLOSE_NOTE_MAX}
                error={formState.errors.note?.message ?? (noteMissing && counted !== null ? 'Add a note to close — the difference is over your tolerance.' : undefined)}
                data-testid="pos-close-note"
                {...register('note')}
              />
              <div className="grid grid-cols-2 items-end gap-3">
                <Input
                  label="Leave in drawer"
                  inputMode="decimal"
                  error={banked === null && counted !== null ? 'Between ৳ 0 and the counted cash' : undefined}
                  data-testid="pos-leave-in-drawer"
                  {...register('left')}
                />
                <div className="flex flex-col pb-2">
                  <span className="text-caption text-text-secondary">Banked</span>
                  <span className="text-body-lg font-semibold text-text-primary" data-testid="pos-banked">
                    {banked === null ? '—' : formatBdt(banked)}
                  </span>
                </div>
              </div>
            </SideCard>

            <SideCard
              title="Today’s sales"
              aside={<span className="rounded-full bg-brand-50 px-2 py-0.5 text-caption font-medium text-brand-700">{formatCount(t.receipts_count)} receipts</span>}
            >
              {barTotal > 0 && (
                <div className="flex h-2 gap-1 overflow-hidden rounded-full" aria-hidden>
                  {methods
                    .filter((m) => m.amount > 0)
                    .map((m) => (
                      <span key={m.method} className={cn('h-2 rounded-full', barTone[m.method])} style={{ width: `${(m.amount / barTotal) * 100}%` }} />
                    ))}
                </div>
              )}
              <div className="flex flex-col gap-2">
                {methods.map((m) => (
                  <Row
                    key={m.method}
                    label={
                      <span className="flex items-center gap-2">
                        <span aria-hidden className={cn('size-2 rounded-full', barTone[m.method])} />
                        {m.label}
                      </span>
                    }
                    value={formatBdt(m.amount)}
                  />
                ))}
                <Row label="Returns" value={`${formatCount(t.returns_count)} · ${formatBdt(t.returns_amount)}`} />
                <Row label="Discounts given" value={formatBdt(t.discounts_amount)} />
                <Row label="Total sales" value={formatBdt(t.sales_amount)} strong />
              </div>
              {t.held_sales_count > 0 && (
                <p className="rounded-lg bg-warning-bg px-3 py-2 text-body text-warning" role="alert">
                  {formatCount(t.held_sales_count)} held {t.held_sales_count === 1 ? 'sale' : 'sales'} will be deleted
                </p>
              )}
            </SideCard>

            {serverError && (
              <p className="rounded-lg bg-danger-bg px-4 py-3 text-body text-danger" role="alert">
                {serverError}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" onClick={printPos} data-testid="pos-print-z">
                Print Z-report
              </Button>
              <Button disabled={!ready || close.isPending} onClick={() => setConfirming(true)} data-testid="pos-close-submit">
                Close register
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={confirming}
        onClose={() => !close.isPending && setConfirming(false)}
        title={`Close ${session.register.name}?`}
        description={`Counted ${formatBdt(counted)} · ${variance.label} · bank ${formatBdt(banked)} and leave ${formatBdt(left)} in the drawer.`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" disabled={close.isPending} onClick={() => setConfirming(false)}>
              Keep open
            </Button>
            <Button disabled={close.isPending} onClick={() => void handleSubmit((v) => close.mutate(v))()} data-testid="pos-close-confirm">
              {close.isPending ? 'Closing…' : 'Close register'}
            </Button>
          </>
        }
      >
        <p className="text-body text-text-secondary">
          {t.held_sales_count > 0 ? `${formatCount(t.held_sales_count)} held sales will be deleted. ` : ''}
          Sales on this register stop until it is opened again.
        </p>
      </Modal>

      <PrintArea>
        <ZReportView
          session={{
            ...session,
            counted_cash_amount: counted,
            variance_amount: counted === null ? null : variance.variance,
            left_in_drawer_amount: counted === null ? null : left,
            banked_amount: banked,
            close_note: noteText.trim() || null,
          }}
          shopName={scope.store?.name ?? ''}
        />
      </PrintArea>
    </div>
  );
}
