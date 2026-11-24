import { isApiError } from '@storeplix/api-client';
import { PURCHASE_INVOICE_MAX_BYTES, SUPPLIER_INVOICE_REF_MAX, type PurchaseInvoice, type PurchaseOrderDetail, type PurchaseOrderEvent, type PurchaseOrderLine } from '@storeplix/types';
import { Button, cn, Dialog, Input, Menu, type MenuEntry } from '@storeplix/ui';
import { Check, ChevronRight, ClipboardList, CreditCard, FileText, MessageCircle, MoreHorizontal, Paperclip, Phone, Printer, Send, Trash2, Truck, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { saveFile } from '../catalog/download';
import { formatBdt, formatCount } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, StateCard } from '../catalog/states';
import { Thumb } from '../catalog/ui';
import { newIdempotencyKey } from '../commerce/format';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { api } from '../lib/api';
import { formatBdPhone } from '../lib/phone';
import { LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { useFeatures } from '../plan/useFeatures';
import { Card, PoStatusBadge, PurchasingPlanNote, SupplierIcon } from './components';
import { RecordPaymentDialog } from './dialogs';
import {
  dayMonth,
  dayTime,
  eventText,
  isOpen,
  localDate,
  methodLabel,
  parseQty,
  progressOf,
  purchasingLocked,
  receiveAll,
  receiveFooter,
  receiveLineError,
  receiveTotals,
  telLink,
  whatsappLink,
  whatsappPoOf,
  whatsappText,
  type ReceiveDraft,
  purchasingError,
} from './purchasing';
import { usePurchaseOrder, usePurchaseOrderMutations, useSupplierMutations } from './queries';

// PHASE-8-8B §10.3 PO detail / Receive stock — Figma 36:6607: header pill, Print (PDF), Record payment, More (Mark as
// ordered, Edit, Close, Cancel, Delete draft — composed menu); progress card with received / receiving now / damaged
// legend and the money summary (Total / Paid / Due; hidden for adjust-only receivers); Receive items with RECEIVING NOW
// and DAMAGED inputs, "Receive all remaining", footer "Adding n units to stock" / "Stock value + ৳ x · cost prices
// updated" (location text dropped), "Attach supplier invoice", "Receive n units"; supplier card (Call / WhatsApp);
// payments card; history (no "Approved by"); documents (invoices + PO PDF). Below md the receive table stacks per line.

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

export default function PurchaseOrderPage() {
  const { id } = useParams();
  const q = usePurchaseOrder(id);
  if (q.isPending) return <LoadingState label="Loading purchase order" />;
  if (q.isError)
    return (
      <StateCard>
        <ErrorBlock error={q.error} title={isApiError(q.error) && q.error.status === 404 ? 'Purchase order not found' : 'We couldn’t load this purchase order'} onRetry={() => void q.refetch()} />
      </StateCard>
    );
  return <Detail po={q.data} />;
}

type Confirm = 'close' | 'cancel' | 'delete' | null;

function Detail({ po }: { po: PurchaseOrderDetail }) {
  const scope = useStoreScope();
  const navigate = useNavigate();
  const manage = scope.canManagePurchasing;
  const canReceive = scope.canReceiveStock && isOpen(po.status);
  const locked = purchasingLocked(useFeatures().data);
  const m = usePurchaseOrderMutations();
  const [draft, setDraft] = useState<ReceiveDraft>({});
  const [paying, setPaying] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [printing, setPrinting] = useState(false);
  const tz = scope.store?.timezone;

  const now = receiveTotals(po.lines, draft);
  const progress = progressOf(po, now);
  const money = po.total_amount !== null;
  const due = money ? (po.total_amount ?? 0) - (po.paid_amount ?? 0) : null;

  const print = async () => {
    setPrinting(true);
    try {
      saveFile(await api.purchaseOrders.pdf(scope.storeId!, po.id, po.number));
    } catch (e) {
      toast(purchasingError(e, 'We couldn’t make the PDF.') ?? 'We couldn’t make the PDF.', 'error');
    } finally {
      setPrinting(false);
    }
  };

  const transition = (kind: 'markOrdered' | 'close' | 'cancel', done: string) =>
    m[kind].mutate(
      { id: po.id, revision: po.revision },
      {
        onSuccess: () => {
          toast(done);
          setConfirm(null);
        },
        onError: (e) => {
          setConfirm(null);
          const msg = purchasingError(e, 'We couldn’t update this purchase order.');
          if (msg) toast(msg, 'error');
        },
      },
    );

  const sendWhatsApp = () => {
    const url = whatsappLink(po.supplier.phone, whatsappText(whatsappPoOf(po, scope.store?.name ?? '')));
    if (!url) return toast('This supplier has no phone number.', 'error');
    window.open(url, '_blank', 'noopener,noreferrer');
    m.send.mutate(
      { id: po.id, input: { sent_via: 'whatsapp', revision: po.revision } },
      { onSuccess: (p) => toast(`${p.number} sent to ${p.supplier.name}.`), onError: (e) => toast(purchasingError(e, 'We couldn’t mark it as sent.') ?? 'We couldn’t mark it as sent.', 'error') },
    );
  };

  const menu: MenuEntry[] = [
    ...(po.status === 'draft'
      ? [
          { key: 'send', label: 'Send on WhatsApp', icon: <MessageCircle />, onSelect: sendWhatsApp, disabled: !po.supplier.phone },
          { key: 'ordered', label: 'Mark as ordered', hint: 'Sent another way', icon: <Send />, onSelect: () => transition('markOrdered', `${po.number} marked as ordered.`) },
        ]
      : []),
    ...(po.status === 'draft' || po.status === 'ordered' ? [{ key: 'edit', label: 'Edit', icon: <ClipboardList />, onSelect: () => navigate(`/inventory/purchase-orders/${po.id}/edit`) }] : []),
    ...(isOpen(po.status) ? [{ key: 'close', label: 'Close', hint: 'Stop expecting the rest', icon: <Check />, onSelect: () => setConfirm('close') }] : []),
    ...((po.status === 'ordered' || po.status === 'draft') && po.units_received === 0 && po.units_damaged === 0
      ? [{ key: 'cancel', label: 'Cancel order', icon: <X />, danger: true, onSelect: () => setConfirm('cancel') }]
      : []),
    ...(po.status === 'draft' ? [{ key: 'delete', label: 'Delete draft', icon: <Trash2 />, danger: true, onSelect: () => setConfirm('delete') }] : []),
  ];

  const sub = [
    po.ordered_at ? `Ordered ${dayMonth(localDate(po.ordered_at, tz))}` : `Created ${dayMonth(localDate(po.created_at, tz))}`,
    po.expected_on ? `expected ${dayMonth(po.expected_on)}` : null,
    po.sent_at ? `sent ${po.sent_via === 'whatsapp' ? 'on WhatsApp' : po.sent_via === 'pdf' ? 'as PDF' : ''}`.trim() : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-body font-medium text-text-secondary">
        <Link to="/inventory" className="text-brand-600 hover:text-brand-700">
          Inventory
        </Link>
        <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
        <Link to="/inventory/purchase-orders" className="text-brand-600 hover:text-brand-700">
          Purchase orders
        </Link>
        <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
        <span>{po.number}</span>
      </nav>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-heading-24 text-text-primary">
            {po.number} · {po.supplier.name}
          </h1>
          <p className="text-body text-text-secondary">{sub}</p>
          <span>
            <PoStatusBadge status={po.status} />
            {po.is_late && (
              <span className="ml-2 text-caption font-medium text-danger">
                {po.days_late} {po.days_late === 1 ? 'day' : 'days'} late
              </span>
            )}
          </span>
        </div>
        {manage && (
          <ReadOnlyActions className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="secondary" loading={printing} onClick={() => void print()}>
              <Printer aria-hidden className="size-4" /> Print
            </Button>
            {po.status !== 'draft' && po.status !== 'cancelled' && (
              <Button variant="secondary" onClick={() => setPaying(true)}>
                Record payment
              </Button>
            )}
            {menu.length > 0 && (
              <Menu
                label="More actions"
                triggerClassName="h-10 w-auto gap-1 rounded-md border border-border-default bg-surface-card px-3 text-body font-medium text-text-primary"
                trigger={
                  <>
                    More <MoreHorizontal aria-hidden className="size-4" />
                  </>
                }
                entries={menu}
              />
            )}
          </ReadOnlyActions>
        )}
      </div>
      {locked && manage && <PurchasingPlanNote canSeePlans={scope.canViewBilling} />}

      <section aria-label="Progress" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-body-lg font-medium text-text-primary">{progress.title}</h2>
            {progress.coming && isOpen(po.status) && <span className="text-body text-text-secondary">{progress.coming}</span>}
          </div>
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-surface-subtle" aria-hidden>
            <div className="h-2 rounded-full bg-success" style={{ width: `${progress.received * 100}%` }} />
            <div className="h-2 rounded-full bg-brand-500" style={{ width: `${progress.now * 100}%` }} />
            <div className="h-2 rounded-full bg-danger" style={{ width: `${progress.damaged * 100}%` }} />
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-success" /> Received {formatCount(po.units_received)}
            </li>
            {canReceive && (
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-full bg-brand-500" /> Receiving now {formatCount(now.units)}
              </li>
            )}
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-danger" /> Damaged {formatCount(progress.damagedUnits)}
            </li>
          </ul>
        </div>
        {money && (
          <dl aria-label="Money" className="grid grid-cols-3 gap-4 border-border-default lg:border-l lg:pl-6">
            <div className="flex flex-col gap-1">
              <dt className="text-caption text-text-secondary">Total</dt>
              <dd className="text-heading text-text-primary">{formatBdt(po.total_amount)}</dd>
            </div>
            <div className="flex flex-col gap-1 border-l border-border-default pl-4">
              <dt className="text-caption text-text-secondary">Paid</dt>
              <dd className="text-heading text-success">{formatBdt(po.paid_amount)}</dd>
            </div>
            <div className="flex flex-col gap-1 border-l border-border-default pl-4">
              <dt className="text-caption text-text-secondary">Due</dt>
              <dd className={cn('text-heading', (due ?? 0) > 0 ? 'text-warning' : 'text-text-primary')}>{formatBdt(Math.max(0, due ?? 0))}</dd>
            </div>
          </dl>
        )}
      </section>

      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <ReceiveCard po={po} draft={draft} setDraft={setDraft} canReceive={canReceive} />
        <div className="flex min-w-0 flex-col gap-5">
          <SupplierCard po={po} />
          {manage && <PaymentsCard po={po} receivingValue={now.value} onRecord={() => setPaying(true)} />}
          <History events={po.events} tz={tz} />
          <Documents po={po} onPdf={manage ? () => void print() : undefined} />
        </div>
      </div>

      {paying && (
        <RecordPaymentDialog
          supplier={{ id: po.supplier.id, name: po.supplier.name, pays_by_method: po.supplier.pays_by_method }}
          purchaseOrders={[{ id: po.id, number: po.number }]}
          defaultPoId={po.id}
          defaultAmount={due !== null && due > 0 ? due : null}
          onClose={() => setPaying(false)}
        />
      )}
      <Dialog
        open={confirm === 'close'}
        title={`Close ${po.number}?`}
        description={`${formatCount(po.units_left)} units still expected will stop counting as incoming. What you received stays in stock.`}
        confirmLabel="Close order"
        loading={m.close.isPending}
        onConfirm={() => transition('close', `${po.number} closed.`)}
        onCancel={() => setConfirm(null)}
      />
      <Dialog
        open={confirm === 'cancel'}
        tone="danger"
        title={`Cancel ${po.number}?`}
        description="Nothing has been received. The order stays in your list as cancelled."
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        loading={m.cancel.isPending}
        onConfirm={() => transition('cancel', `${po.number} cancelled.`)}
        onCancel={() => setConfirm(null)}
      />
      <Dialog
        open={confirm === 'delete'}
        tone="danger"
        title={`Delete ${po.number}?`}
        description="The draft is removed. Its number is not reused."
        confirmLabel="Delete draft"
        loading={m.remove.isPending}
        onConfirm={() =>
          m.remove.mutate(po.id, {
            onSuccess: () => {
              toast(`${po.number} deleted.`);
              navigate('/inventory/purchase-orders');
            },
            onError: (e) => {
              setConfirm(null);
              const msg = purchasingError(e, 'We couldn’t delete this draft.');
              if (msg) toast(msg, 'error');
            },
          })
        }
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

// ---------- Receive items ----------

function ReceiveCard({ po, draft, setDraft, canReceive }: { po: PurchaseOrderDetail; draft: ReceiveDraft; setDraft: (d: ReceiveDraft) => void; canReceive: boolean }) {
  const scope = useStoreScope();
  const { receive } = usePurchaseOrderMutations();
  const key = useRef(newIdempotencyKey());
  const [invoice, setInvoice] = useState<(PurchaseInvoice & { name: string }) | null>(null);
  const [invoiceRef, setInvoiceRef] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const totals = receiveTotals(po.lines, draft);
  const footer = receiveFooter(totals);
  const errors = Object.fromEntries(po.lines.map((l) => [l.id, receiveLineError(l, draft[l.id])]));
  const invalid = Object.values(errors).some(Boolean);
  const open = po.lines.filter((l) => l.quantity_left > 0);

  const set = (line: PurchaseOrderLine, field: 'received' | 'damaged', text: string) => {
    const n = parseQty(text);
    const cur = draft[line.id] ?? { received: 0, damaged: 0 };
    setDraft({ ...draft, [line.id]: { ...cur, [field]: n === null ? 0 : n } });
    setError(null);
  };

  const pick = async (file: File | undefined) => {
    if (!file || !scope.storeId) return;
    if (file.size > PURCHASE_INVOICE_MAX_BYTES) return setError('The invoice file may not be larger than 5 MB.');
    setUploading(true);
    setError(null);
    try {
      const r = await api.purchasing.uploadInvoice(scope.storeId, { file, filename: file.name });
      setInvoice({ ...r, name: file.name });
    } catch (e) {
      setError(isApiError(e) ? (e.fieldError('file') ?? e.message) : 'Upload failed. Check your connection.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = () => {
    if (invalid || totals.units + totals.damaged === 0) return;
    setError(null);
    receive.mutate(
      {
        id: po.id,
        key: key.current,
        input: {
          lines: po.lines.filter((l) => draft[l.id] && draft[l.id]!.received + draft[l.id]!.damaged > 0).map((l) => ({ item_id: l.id, received: draft[l.id]!.received, damaged: draft[l.id]!.damaged })),
          supplier_invoice_ref: invoiceRef.trim() || null,
          invoice_media_id: invoice?.id ?? null,
        },
      },
      {
        onSuccess: (next) => {
          toast(`${formatCount(totals.units)} units added to stock${next.status === 'received' ? ` · ${next.number} fully received` : ''}.`);
          key.current = newIdempotencyKey();
          setDraft({});
          setInvoice(null);
          setInvoiceRef('');
        },
        onError: (e) => setError(purchasingError(e, 'We couldn’t record this delivery.')),
      },
    );
  };

  const money = po.total_amount !== null;
  return (
    <section aria-label="Receive items" className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">
      <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-body-lg font-medium text-text-primary">{canReceive ? 'Receive items' : 'Items'}</h2>
          {canReceive && <p className="text-caption text-text-secondary">Count what arrived. Damaged pieces are not added to stock.</p>}
        </div>
        {canReceive && open.length > 0 && (
          <ReadOnlyActions>
            <Button size="sm" variant="secondary" onClick={() => setDraft(receiveAll(po.lines))}>
              Receive all remaining
            </Button>
          </ReadOnlyActions>
        )}
      </div>
      <div role="table" aria-label="Purchase order items">
        <div role="row" className="hidden items-center gap-3 border-y border-border-default bg-surface-subtle px-6 py-2.5 text-caption font-medium text-text-muted uppercase md:flex">
          <span role="columnheader" className="min-w-0 flex-1">
            Product
          </span>
          <span role="columnheader" className="w-16 text-right">
            Ordered
          </span>
          <span role="columnheader" className="w-16 text-right">
            Received
          </span>
          {canReceive && (
            <>
              <span role="columnheader" className="w-24">
                Receiving now
              </span>
              <span role="columnheader" className="w-20">
                Damaged
              </span>
            </>
          )}
          <span role="columnheader" className="w-12 text-right">
            Left
          </span>
        </div>
        {po.lines.map((l) => {
          const name = `${l.product.name}${l.variant_title !== 'Default' ? ` ${l.variant_title}` : ''}`;
          const v = draft[l.id];
          const err = errors[l.id];
          const leftAfter = Math.max(0, l.quantity_left - (v?.received ?? 0) - (v?.damaged ?? 0));
          return (
            <div role="row" key={l.id} aria-label={name} className="flex flex-col gap-3 border-t border-border-default px-4 py-4 first:border-t-0 md:flex-row md:items-center md:px-6">
              <div role="cell" className="flex min-w-0 flex-1 items-center gap-3">
                <Thumb src={l.product.image?.url} size={44} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-body font-medium text-text-primary">{l.product.name}</span>
                  <span className="truncate text-caption text-text-secondary">
                    {[l.variant_title !== 'Default' ? l.variant_title : null, money ? formatBdt(l.unit_cost_amount) : null].filter(Boolean).join(' · ')}
                  </span>
                  {l.quantity_damaged > 0 && <span className="text-caption text-danger">{formatCount(l.quantity_damaged)} damaged</span>}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-body md:contents">
                <Num label="Ordered" value={l.quantity_ordered} />
                <Num label="Received" value={l.quantity_received} className={l.quantity_received > 0 ? 'text-success' : undefined} />
                {!canReceive && <Num label="Left" value={l.quantity_left} />}
              </div>
              {canReceive &&
                (l.quantity_left === 0 ? (
                  <div role="cell" className="flex items-center gap-1.5 text-caption font-medium text-success md:w-[188px]">
                    <Check aria-hidden className="size-4" /> Fully received
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 md:contents">
                    <div role="cell" className="flex flex-col gap-1 md:w-24">
                      <span className="text-caption text-text-muted md:hidden">Receiving now</span>
                      <input
                        aria-label={`Receiving now of ${name}`}
                        inputMode="numeric"
                        value={v ? String(v.received || '') : ''}
                        onChange={(e) => set(l, 'received', e.target.value)}
                        className={cn('min-h-10 w-full rounded-md border bg-surface-card px-3 text-center text-body text-text-primary outline-none focus:border-brand-600', v?.received ? 'border-brand-600' : 'border-border-default', err && 'border-danger')}
                      />
                    </div>
                    <div role="cell" className="flex flex-col gap-1 md:w-20">
                      <span className="text-caption text-text-muted md:hidden">Damaged</span>
                      <input
                        aria-label={`Damaged of ${name}`}
                        inputMode="numeric"
                        value={v ? String(v.damaged || '') : ''}
                        onChange={(e) => set(l, 'damaged', e.target.value)}
                        className={cn('min-h-10 w-full rounded-md border bg-surface-card px-3 text-center text-body outline-none focus:border-brand-600', v?.damaged ? 'border-danger text-danger' : 'border-border-default text-text-primary')}
                      />
                    </div>
                  </div>
                ))}
              {canReceive && <Num label="Left" value={leftAfter} className={leftAfter === 0 ? 'text-success md:w-12' : 'md:w-12'} />}
              {err && (
                <p role="alert" className="text-caption text-danger md:basis-full">
                  {err}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {canReceive && (
        <div className="flex flex-col gap-3 border-t border-border-default bg-brand-50 px-4 py-4 sm:px-6 xl:flex-row xl:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5" aria-live="polite">
            <span className="text-body font-medium text-brand-700">{footer.title}</span>
            {footer.detail && <span className="text-caption text-text-secondary">{footer.detail}</span>}
            {invoice && (
              <span className="flex items-center gap-1.5 text-caption text-text-secondary">
                <Paperclip aria-hidden className="size-3.5" /> {invoice.name}
                <button type="button" aria-label="Remove invoice" onClick={() => setInvoice(null)} className="text-text-muted hover:text-danger">
                  <X aria-hidden className="size-3.5" />
                </button>
              </span>
            )}
            {error && (
              <p role="alert" className="text-caption text-danger">
                {error}
              </p>
            )}
          </div>
          <ReadOnlyActions className="flex flex-wrap items-center gap-2">
            <Input aria-label="Supplier invoice number" placeholder="Invoice no." value={invoiceRef} maxLength={SUPPLIER_INVOICE_REF_MAX} onChange={(e) => setInvoiceRef(e.target.value)} containerClassName="w-32" fieldClassName="min-h-10" />
            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" aria-label="Supplier invoice file" onChange={(e) => void pick(e.target.files?.[0])} />
            <Button variant="secondary" loading={uploading} onClick={() => fileRef.current?.click()}>
              {invoice ? 'Change invoice' : 'Attach supplier invoice'}
            </Button>
            <Button loading={receive.isPending} disabled={invalid || totals.units + totals.damaged === 0} onClick={submit}>
              {totals.units > 0 ? `Receive ${formatCount(totals.units)} ${totals.units === 1 ? 'unit' : 'units'}` : totals.damaged > 0 ? 'Record damaged' : 'Receive'}
            </Button>
          </ReadOnlyActions>
        </div>
      )}
    </section>
  );
}

function Num({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div role="cell" className={cn('flex flex-col md:w-16 md:items-end', className)}>
      <span className="text-caption text-text-muted md:hidden">{label}</span>
      <span className="text-body">{formatCount(value)}</span>
    </div>
  );
}

// ---------- Side cards ----------

function SupplierCard({ po }: { po: PurchaseOrderDetail }) {
  const tel = telLink(po.supplier.phone);
  const wa = whatsappLink(po.supplier.phone);
  return (
    <Card aria-label="Supplier" className="gap-3">
      <div className="flex items-center gap-3">
        <SupplierIcon className="bg-brand-50 shadow-none" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body-lg font-medium text-text-primary">{po.supplier.name}</span>
          <span className="truncate text-caption text-text-secondary">{[po.supplier.contact_name, po.supplier.phone ? formatBdPhone(po.supplier.phone) : null].filter(Boolean).join(' · ') || 'No contact details'}</span>
        </div>
      </div>
      {(tel || wa) && (
        <div className="grid grid-cols-2 gap-2">
          {tel && (
            <a href={tel} className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-border-default text-caption font-medium text-text-primary hover:bg-surface-subtle">
              <Phone aria-hidden className="size-3.5" /> Call
            </a>
          )}
          {wa && (
            <a href={wa} target="_blank" rel="noopener noreferrer" className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-border-default text-caption font-medium text-text-primary hover:bg-surface-subtle">
              <MessageCircle aria-hidden className="size-3.5" /> WhatsApp
            </a>
          )}
        </div>
      )}
    </Card>
  );
}

function PaymentsCard({ po, receivingValue, onRecord }: { po: PurchaseOrderDetail; receivingValue: number | null; onRecord: () => void }) {
  const { deletePayment } = useSupplierMutations();
  const [removing, setRemoving] = useState<string | null>(null);
  const received = po.received_value_amount ?? 0;
  const paid = po.paid_amount ?? 0;
  const due = (po.total_amount ?? 0) - paid;
  const owedNow = received - paid;
  const owedAfter = receivingValue && receivingValue > 0 ? owedNow + receivingValue : null;
  const target = po.payments.find((p) => p.id === removing);
  return (
    <Card aria-label="Payments to supplier" className="gap-3">
      <h2 className="text-body-lg font-medium text-text-primary">Payments to supplier</h2>
      <dl className="flex flex-col gap-2 text-body">
        {po.payments.length === 0 && <p className="text-text-muted">No payments yet.</p>}
        {po.payments.map((p) => (
          <div key={p.id} className="group flex items-center justify-between gap-2">
            <dt className="min-w-0 truncate text-text-secondary">
              {dayMonth(p.paid_on)} · {methodLabel(p.method)}
              {p.note ? ` · ${p.note}` : ''}
            </dt>
            <dd className="flex items-center gap-1.5 font-medium text-success">
              {formatBdt(p.amount)}
              <ReadOnlyActions>
                <button type="button" aria-label={`Remove payment of ${formatBdt(p.amount)}`} onClick={() => setRemoving(p.id)} className="flex size-6 items-center justify-center rounded-sm text-text-muted hover:text-danger">
                  <Trash2 aria-hidden className="size-3.5" />
                </button>
              </ReadOnlyActions>
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <dt className="text-text-secondary">Owed for received goods</dt>
          <dd className="font-medium text-text-primary">{formatBdt(owedNow)}</dd>
        </div>
        {owedAfter !== null && (
          <div className="flex items-center justify-between">
            <dt className="text-text-secondary">Owed after this receipt</dt>
            <dd className="font-medium text-warning">{formatBdt(owedAfter)}</dd>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-border-default pt-3">
          <dt className="font-semibold text-text-primary">Due</dt>
          <dd className="text-heading font-semibold text-text-primary">{formatBdt(Math.max(0, due))}</dd>
        </div>
      </dl>
      {po.status !== 'draft' && po.status !== 'cancelled' && (
        <ReadOnlyActions>
          <Button size="sm" className="w-full" onClick={onRecord}>
            <CreditCard aria-hidden className="size-4" /> Record payment
          </Button>
        </ReadOnlyActions>
      )}
      <Dialog
        open={!!target}
        tone="danger"
        title="Remove this payment?"
        description={target ? `${formatBdt(target.amount)} paid on ${dayMonth(target.paid_on)} will be removed. What you owe goes up again.` : undefined}
        confirmLabel="Remove payment"
        loading={deletePayment.isPending}
        onConfirm={() =>
          deletePayment.mutate(removing!, {
            onSuccess: () => {
              toast('Payment removed.');
              setRemoving(null);
            },
            onError: (e) => {
              setRemoving(null);
              const msg = purchasingError(e, 'We couldn’t remove this payment.');
              if (msg) toast(msg, 'error');
            },
          })
        }
        onCancel={() => setRemoving(null)}
      />
    </Card>
  );
}

const eventIcon = (e: PurchaseOrderEvent) => {
  switch (e.type) {
    case 'sent':
      return MessageCircle;
    case 'payment_recorded':
    case 'payment_deleted':
      return CreditCard;
    case 'received':
    case 'quick_received':
      return Truck;
    case 'marked_ordered':
    case 'closed':
      return Check;
    case 'cancelled':
      return X;
    default:
      return ClipboardList;
  }
};

function History({ events, tz }: { events: PurchaseOrderEvent[]; tz: string | null | undefined }) {
  if (events.length === 0) return null;
  return (
    <Card aria-label="History" className="gap-3">
      <h2 className="text-body-lg font-medium text-text-primary">History</h2>
      <ol className="flex flex-col gap-4">
        {events.map((e, i) => {
          const Icon = eventIcon(e);
          return (
            <li key={i} className="flex items-start gap-3">
              <span aria-hidden className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', e.type === 'received' || e.type === 'quick_received' || e.type === 'sent' ? 'bg-success-bg text-success' : 'bg-brand-50 text-brand-600')}>
                <Icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-body font-medium text-text-primary">{eventText(e)}</span>
                <span className="text-caption text-text-muted">{dayTime(e.created_at, tz)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function Documents({ po, onPdf }: { po: PurchaseOrderDetail; onPdf?: () => void }) {
  const invoices = po.receipts.filter((r) => r.invoice);
  if (invoices.length === 0 && !onPdf) return null;
  return (
    <Card aria-label="Documents" className="gap-3">
      <h2 className="text-body-lg font-medium text-text-primary">Documents</h2>
      <ul className="flex flex-col gap-2">
        {invoices.map((r) => (
          <li key={r.id}>
            <DocRow
              title={`Supplier invoice${r.supplier_invoice_ref ? ` ${r.supplier_invoice_ref}` : ''}`}
              detail={`${dayMonth(r.received_at.slice(0, 10))} · ${r.invoice!.size_bytes >= 1_000_000 ? `${(r.invoice!.size_bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(r.invoice!.size_bytes / 1000))} KB`}${r.invoice!.status === 'processing' ? ' · processing' : ''}`}
              href={r.invoice!.url}
            />
          </li>
        ))}
        {onPdf && (
          <li>
            <DocRow title={`${po.number}.pdf`} detail={po.sent_at ? `Sent ${dayMonth(po.sent_at.slice(0, 10))}` : 'Not sent yet'} onClick={onPdf} />
          </li>
        )}
      </ul>
    </Card>
  );
}

function DocRow({ title, detail, href, onClick }: { title: string; detail: string; href?: string | null; onClick?: () => void }) {
  const body = (
    <>
      <FileText aria-hidden className="size-4 shrink-0 text-text-secondary" />
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-body font-medium text-text-primary">{title}</span>
        <span className="text-caption text-text-muted">{detail}</span>
      </span>
    </>
  );
  const cls = 'flex w-full items-center gap-3 rounded-lg bg-surface-subtle px-3 py-2.5 outline-none hover:bg-surface-canvas focus-visible:shadow-focus';
  if (href)
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls}>
        {body}
      </button>
    );
  return <div className={cls}>{body}</div>;
}
