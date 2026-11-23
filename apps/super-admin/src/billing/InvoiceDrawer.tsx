import { zodResolver } from '@hookform/resolvers/zod';
import type { AdminInvoice } from '@storeplix/types';
import { Badge, Button, Dialog, Drawer, Input, Menu, Skeleton } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, Download, MoreHorizontal, Send } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { InvoiceStatusBadge } from '../components/badges';
import { LoggedAs } from '../components/LoggedAs';
import { ReasonDialog } from '../components/ReasonDialog';
import { ReasonField } from '../components/ReasonField';
import { reasonSchema } from '../components/reason';
import { ErrorState } from '../components/States';
import { api } from '../lib/api';
import { saveBlob } from '../lib/download';
import { errorMessage } from '../lib/errors';
import { formatDate, formatDateTime, intervalLabel, money, planName, providerLabel } from '../lib/format';
import { newIdempotencyKey } from '../lib/ids';
import { useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';

const paymentTone = {
  succeeded: 'bg-success',
  failed: 'bg-danger',
  pending: 'bg-info',
  cancelled: 'bg-text-muted',
} as const;

// Invoice drawer 36:1598 (§7.1, P8-15): header (number + status, shop · plan · interval, Download PDF / More / Open
// shop), amount box, Billed to, dates, lines + totals, payment attempts. Refund is hidden (Q89); the "More" menu holds
// Mark paid (reference + reason), Void (reason) and Resend — only with `manage_billing`.
export function InvoiceDrawer({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'paid' | 'void' | null>(null);
  const invoice = useQuery({
    queryKey: ['admin', 'invoice', invoiceId],
    queryFn: () => api.admin.invoices.get(invoiceId),
  });
  const inv = invoice.data;

  const refresh = (updated?: AdminInvoice) => {
    if (updated) queryClient.setQueryData(['admin', 'invoice', invoiceId], updated);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });
  };

  const pdf = useMutation({
    mutationFn: () => api.admin.invoices.pdf(invoiceId, inv?.number),
    onSuccess: (file) => saveBlob(file.blob, file.filename),
    onError: (e) => toast(errorMessage(e), 'danger'),
  });
  const resend = useMutation({
    mutationFn: () => api.admin.invoices.resend(invoiceId),
    onSuccess: () => toast('Invoice email sent to the owner'),
    onError: (e) => toast(errorMessage(e), 'danger'),
  });

  const manage = can('manage_billing');
  const open = inv?.status === 'open';
  const menu = manage
    ? [
        ...(open
          ? [
              {
                key: 'paid',
                label: 'Mark paid',
                hint: 'Record a manual payment',
                icon: <CheckCircle2 />,
                onSelect: () => setDialog('paid'),
              },
            ]
          : []),
        ...(open
          ? [
              {
                key: 'void',
                label: 'Void',
                hint: 'Cancel this open invoice',
                icon: <Ban />,
                danger: true,
                onSelect: () => setDialog('void'),
              },
            ]
          : []),
        {
          key: 'resend',
          label: 'Resend',
          hint: 'Email the invoice to the owner again',
          icon: <Send />,
          onSelect: () => resend.mutate(),
        },
      ]
    : [];

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        width={460}
        title={inv ? inv.number : 'Invoice'}
        description={inv ? `${inv.tenant.name} · ${planName(inv.plan_code)} · ${intervalLabel(inv.interval).toLowerCase()}` : undefined}
        footer={
          inv && (
            <>
              <div className="flex-1" />
              <Button onClick={() => pdf.mutate()} loading={pdf.isPending}>
                <Download aria-hidden className="size-4" />
                Download PDF
              </Button>
            </>
          )
        }
      >
        {invoice.isPending ? (
          <div role="status" aria-label="Loading invoice" className="flex flex-col gap-3 p-5">
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        ) : invoice.isError ? (
          <ErrorState error={invoice.error} onRetry={() => void invoice.refetch()} />
        ) : (
          inv && (
            <div className="flex flex-col gap-5 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <InvoiceStatusBadge status={inv.status} overdue={inv.is_overdue} />
                <div className="flex-1" />
                {menu.length > 0 && (
                  <Menu
                    label="More invoice actions"
                    triggerClassName="size-8 rounded-md border border-border-default"
                    trigger={<MoreHorizontal aria-hidden className="size-4" />}
                    entries={menu}
                  />
                )}
                <Link to={`/merchants/${inv.tenant.id}`} className="text-body font-medium text-brand-600 hover:underline">
                  Open shop
                </Link>
              </div>

              <div className="flex items-end justify-between gap-3 rounded-lg bg-surface-subtle px-4 py-3.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-caption text-text-secondary">
                    {inv.status === 'paid' ? 'Amount paid' : inv.status === 'void' ? 'Amount (void)' : 'Amount due'}
                  </span>
                  <span className="text-heading-24 text-text-primary tabular-nums">{money(inv.total_amount)}</span>
                </div>
                <span className="text-right text-caption text-text-secondary">
                  {inv.status === 'paid'
                    ? `Paid ${formatDateTime(inv.paid_at)}`
                    : inv.status === 'void'
                    ? `Voided ${formatDate(inv.voided_at)}`
                    : `Due ${formatDate(inv.due_at)}`}
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-body">
                <div className="col-span-2 flex flex-col gap-0.5">
                  <dt className="text-caption text-text-muted uppercase">Billed to</dt>
                  <dd className="font-semibold text-text-primary">{inv.bill_to.name}</dd>
                  {[inv.bill_to.email, inv.bill_to.phone, inv.bill_to.address].filter(Boolean).map((l) => (
                    <dd key={l} className="text-caption text-text-secondary">
                      {l}
                    </dd>
                  ))}
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-caption text-text-muted">Issued</dt>
                  <dd className="text-text-primary">{formatDate(inv.issued_at)}</dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-caption text-text-muted">Service period</dt>
                  <dd className="text-text-primary">{inv.period_start ? `${formatDate(inv.period_start)} – ${formatDate(inv.period_end)}` : '—'}</dd>
                </div>
              </dl>

              <div className="overflow-hidden rounded-lg border border-border-default">
                <div className="flex bg-surface-subtle px-3 py-2 text-caption font-medium text-text-muted uppercase">
                  <span className="flex-1">Description</span>
                  <span className="w-24 text-right">Amount ৳</span>
                </div>
                {inv.lines.map((l, idx) => (
                  <div key={idx} className="flex gap-2 border-t border-border-default px-3 py-2.5">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-body text-text-primary">{l.description}</span>
                      {l.period_start && (
                        <span className="text-caption text-text-muted">
                          {formatDate(l.period_start)} – {formatDate(l.period_end)}
                        </span>
                      )}
                    </span>
                    <span className="w-24 text-right text-body text-text-primary tabular-nums">{money(l.amount)}</span>
                  </div>
                ))}
                <dl className="flex flex-col gap-1.5 border-t border-border-default px-3 py-3 text-body">
                  <Row label="Subtotal" value={money(inv.subtotal_amount)} />
                  {inv.credit_amount > 0 && <Row label="Credit" value={money(-inv.credit_amount)} />}
                  {inv.tax_amount > 0 && (
                    <Row label={`VAT ${(inv.tax_rate_bps / 100).toFixed(inv.tax_rate_bps % 100 ? 2 : 0)}%`} value={money(inv.tax_amount)} />
                  )}
                  <Row label="Total" value={money(inv.total_amount)} strong />
                </dl>
              </div>

              {inv.void_reason && <p className="text-caption text-text-secondary">Void reason: {inv.void_reason}</p>}

              <section aria-label="Payment attempts" className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-body-lg font-semibold text-text-primary">Payment attempts</h3>
                  <Badge size="sm">
                    {inv.payments.length} attempt
                    {inv.payments.length === 1 ? '' : 's'}
                  </Badge>
                </div>
                {inv.payments.length === 0 ? (
                  <p className="text-body text-text-secondary">No payment attempts yet.</p>
                ) : (
                  <ol className="flex flex-col gap-3">
                    {inv.payments.map((p) => (
                      <li key={p.id} className="flex gap-3">
                        <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${paymentTone[p.status]}`} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-body font-medium text-text-primary">
                            {providerLabel(p.provider)} · {p.status}
                            {p.is_duplicate ? ' · duplicate' : ''}
                          </span>
                          <span className="truncate text-caption text-text-muted">
                            {money(p.amount)}
                            {p.provider_reference ? ` · Ref ${p.provider_reference}` : ''}
                            {p.failure_code ? ` · ${p.failure_code}` : ''}
                          </span>
                        </span>
                        <span className="shrink-0 text-caption text-text-muted">{formatDateTime(p.verified_at ?? p.created_at)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          )
        )}
      </Drawer>
      {dialog === 'paid' && inv && (
        <MarkPaidDialog
          invoice={inv}
          onCancel={() => setDialog(null)}
          onDone={(updated) => {
            setDialog(null);
            refresh(updated);
            toast(`${updated.number} marked paid`);
          }}
        />
      )}
      {dialog === 'void' && inv && (
        <ReasonDialog
          title={`Void ${inv.number}?`}
          description="The invoice can no longer be paid. The subscription itself doesn’t change."
          confirmLabel="Void invoice"
          tone="danger"
          onCancel={() => setDialog(null)}
          onSubmit={(reason) => api.admin.invoices.void(inv.id, reason)}
          onDone={(updated) => {
            setDialog(null);
            refresh(updated);
            toast(`${updated.number} voided`);
          }}
        />
      )}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className={strong ? 'font-semibold text-text-primary' : 'text-text-secondary'}>{label}</dt>
      <dd className={strong ? 'font-semibold text-text-primary tabular-nums' : 'text-text-primary tabular-nums'}>{value}</dd>
    </div>
  );
}

const markPaidSchema = z.object({
  reference: z.string().trim().min(1, 'Enter the payment reference').max(120, 'Keep the reference under 120 characters'),
  reason: reasonSchema,
});
type MarkPaidValues = z.infer<typeof markPaidSchema>;

/** P8-15 mark paid = PHASE-7 `billing:mark-paid` (provider manual, reference required, Idempotency-Key). */
export function MarkPaidDialog({ invoice, onCancel, onDone }: { invoice: AdminInvoice; onCancel: () => void; onDone: (inv: AdminInvoice) => void }) {
  const formId = useId();
  const [key] = useState(newIdempotencyKey);
  const { register, handleSubmit, formState } = useForm<MarkPaidValues>({
    resolver: zodResolver(markPaidSchema),
    defaultValues: { reference: '', reason: '' },
  });
  const mutation = useMutation({
    mutationFn: (v: MarkPaidValues) => api.admin.invoices.markPaid(invoice.id, { reference: v.reference.trim(), reason: v.reason.trim() }, key),
    onSuccess: onDone,
  });
  return (
    <Dialog
      open
      title={`Mark ${invoice.number} paid`}
      description={`Records a manual payment of ${money(invoice.total_amount)} and activates the paid period.`}
      confirmLabel="Mark paid"
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      size="md"
      onConfirm={() => undefined}
      onCancel={onCancel}
    >
      <form id={formId} noValidate onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-4">
        <Input label="Payment reference" placeholder="Bank transfer or bKash TrxID" error={formState.errors.reference?.message} {...register('reference')} />
        <ReasonField error={formState.errors.reason?.message} {...register('reason')} />
        {mutation.isError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
            {errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
