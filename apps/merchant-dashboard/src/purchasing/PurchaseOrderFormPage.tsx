import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { InventoryItem, PurchaseOrderDetail, PurchaseOrderSentVia, Supplier, SupplierPaymentMethod } from '@storeplix/types';
import { Button, buttonVariants, cn, Menu, MoneyInput, Select } from '@storeplix/ui';
import { AlertTriangle, ChevronRight, ClipboardList, FileText, MessageCircle, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { saveFile } from '../catalog/download';
import { formatBdt, formatCount, plural } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, StateCard } from '../catalog/states';
import { Thumb } from '../catalog/ui';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { api } from '../lib/api';
import { formatBdPhone } from '../lib/phone';
import { LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { useFeatures } from '../plan/useFeatures';
import { useStockLocations } from '../inventory/locations';
import { localToday } from '../reports/range';
import { Card, PurchasingPlanNote, SupplierIcon, SupplierPickerDialog, VariantPickerDialog } from './components';
import { RecordPaymentDialog, SupplierFormDialog } from './dialogs';
import {
  advanceSplit,
  leadLabel,
  methodLabel,
  parseQty,
  poFormSchema,
  poTotals,
  purchasingLocked,
  TERMS_OPTIONS,
  termsKey,
  termsLabel,
  whatsappLink,
  whatsappPoOf,
  whatsappText,
  type PoFormValues,
  purchasingError,
} from './purchasing';
import { usePurchaseOrder, usePurchaseOrderMutations, useReorderSuggestions, useSupplier } from './queries';

// PHASE-8-8B §10.3 New purchase order — Figma 35:6210 (also "Edit" of a draft/ordered PO, composed). Supplier card with
// Change → supplier picker; Expected by; Payment terms (supplier terms, editable for the advance suggestion); "Receive at"
// 35:6644 (PHASE-8-8C §10.3: only with > 1 active location; locked once the PO has a receipt); items with "Last bought at", IN STOCK, unit cost, quantity, line total, remove (composed);
// "+ Add product" (composed picker), "Add n suggested"; Summary with Transport + Supplier discount, advance suggestion
// + "Record advance"; info note; approval warning hidden (P88B-7); "Save draft"; "Send to supplier" via WhatsApp / PDF
// (Email hidden).

type SupplierCard = Pick<Supplier, 'id' | 'name' | 'contact_name' | 'phone' | 'city' | 'lead_time_days' | 'payment_terms_days' | 'advance_percent' | 'pays_by_method' | 'past_orders_count'> & {
  owed_amount: number | null;
};

interface LineMeta {
  name: string;
  variant: string | null;
  image: string | null | undefined;
  inStock: number;
  lastBought: number | null;
  /** received + damaged (an ordered PO's line can't go below it) */
  handled: number;
}

const metaOfItem = (i: InventoryItem): LineMeta => ({ name: i.product.name, variant: i.title !== 'Default' ? i.title : null, image: i.product.image?.url, inStock: i.on_hand, lastBought: null, handled: 0 });

export default function PurchaseOrderFormPage() {
  const { id } = useParams();
  const existing = usePurchaseOrder(id);
  if (id && existing.isPending) return <LoadingState label="Loading purchase order" />;
  if (id && existing.isError)
    return (
      <StateCard>
        <ErrorBlock error={existing.error} title="We couldn’t load this purchase order" onRetry={() => void existing.refetch()} />
      </StateCard>
    );
  if (existing.data && existing.data.status !== 'draft' && existing.data.status !== 'ordered')
    return (
      <StateCard>
        <ErrorBlock title="This purchase order can’t be edited" message="Only draft and ordered purchase orders can change." />
      </StateCard>
    );
  return <PoForm key={existing.data?.id ?? 'new'} po={existing.data ?? null} />;
}

function PoForm({ po }: { po: PurchaseOrderDetail | null }) {
  const scope = useStoreScope();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const today = localToday(scope.store?.timezone);
  const locked = purchasingLocked(useFeatures().data);
  const m = usePurchaseOrderMutations();
  const preset = useSupplier(po ? null : params.get('supplier'));
  const [supplier, setSupplier] = useState<SupplierCard | null>(po ? po.supplier : null);
  const shownSupplier = supplier ?? (preset.data && !preset.data.archived_at ? preset.data : null);
  const [saved, setSaved] = useState<PurchaseOrderDetail | null>(po);
  const locs = useStockLocations();
  const [receiveAt, setReceiveAt] = useState<string | null>(po?.location.id ?? null);
  const receiveAtId = receiveAt ?? locs.defaultLocation?.id ?? null;
  const receiveAtLocked = !!po && (po.units_received > 0 || po.units_damaged > 0);
  const [meta, setMeta] = useState<Record<string, LineMeta>>(() =>
    Object.fromEntries(
      (po?.lines ?? []).map((l) => [
        l.variant_id,
        { name: l.product.name, variant: l.variant_title !== 'Default' ? l.variant_title : null, image: l.product.image?.url, inStock: l.in_stock, lastBought: l.last_bought_unit_cost_amount, handled: l.quantity_received + l.quantity_damaged },
      ]),
    ),
  );
  const [picking, setPicking] = useState<'supplier' | 'variant' | 'add-supplier' | null>(null);
  const [terms, setTerms] = useState<string | null>(null);
  const [advanceOpen, setAdvanceOpen] = useState<PurchaseOrderDetail | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'draft' | 'send' | 'advance' | null>(null);
  const lastSaved = useRef<PurchaseOrderDetail | null>(po);

  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<PoFormValues>({
    resolver: zodResolver(poFormSchema(today)),
    defaultValues: {
      supplier_id: po?.supplier.id ?? '',
      expected_on: po?.expected_on ?? '',
      shipping_amount: po?.shipping_amount ?? 0,
      discount_amount: po?.discount_amount ?? 0,
      notes: po?.notes ?? '',
      lines: (po?.lines ?? []).map((l) => ({ variant_id: l.variant_id, unit_cost_amount: l.unit_cost_amount, quantity: l.quantity_ordered })),
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines', keyName: 'key' });
  const lines = useWatch({ control, name: 'lines' }) ?? [];
  const shipping = useWatch({ control, name: 'shipping_amount' });
  const discount = useWatch({ control, name: 'discount_amount' });
  const totals = poTotals(lines, shipping ?? null, discount ?? null);

  if (shownSupplier && !supplier) {
    setSupplier(shownSupplier);
    setValue('supplier_id', shownSupplier.id);
  }

  // Payment terms: the supplier's own (default) or one picked here (drives the advance suggestion only).
  const supplierTermsKey = supplier ? termsKey(supplier) : null;
  const termsChoice = terms ?? supplierTermsKey;
  const chosen = TERMS_OPTIONS.find((o) => termsKey({ payment_terms_days: o.terms, advance_percent: o.advance }) === termsChoice);
  const advancePercent = chosen ? chosen.advance : (supplier?.advance_percent ?? null);
  const split = advanceSplit(totals.total, advancePercent);

  const suggestions = useReorderSuggestions(!!supplier);
  const onPo = new Set(lines.map((l) => l.variant_id));
  const suggested = (suggestions.data?.find((g) => g.supplier?.id === supplier?.id)?.items ?? []).filter((i) => !onPo.has(i.variant_id));

  const pickSupplier = (s: SupplierCard) => {
    setSupplier(s);
    setTerms(null);
    setValue('supplier_id', s.id, { shouldValidate: true });
    setPicking(null);
  };

  const addSuggested = () => {
    setMeta((mm) => ({
      ...mm,
      ...Object.fromEntries(suggested.map((i) => [i.variant_id, { name: i.product.name, variant: i.variant_title !== 'Default' ? i.variant_title : null, image: i.product.image?.url, inStock: i.available, lastBought: i.last_unit_cost_amount, handled: 0 }])),
    }));
    for (const i of suggested) append({ variant_id: i.variant_id, unit_cost_amount: i.last_unit_cost_amount ?? 0, quantity: i.suggested_quantity });
  };

  /** Create (first save) or PATCH with the last known revision. */
  const persist = async (v: PoFormValues): Promise<PurchaseOrderDetail> => {
    const body = {
      supplier_id: v.supplier_id,
      expected_on: v.expected_on || null,
      shipping_amount: v.shipping_amount ?? 0,
      discount_amount: v.discount_amount ?? 0,
      notes: v.notes.trim() || null,
      lines: v.lines.map((l) => ({ variant_id: l.variant_id, unit_cost_amount: l.unit_cost_amount ?? 0, quantity: l.quantity ?? 0 })),
      // One-location stores send no location (the API uses the default), exactly as before 8.8c.
      ...(locs.multi && receiveAtId && !receiveAtLocked ? { location_id: receiveAtId } : {}),
    };
    const prev = lastSaved.current;
    const next = prev
      ? await m.update.mutateAsync({ id: prev.id, input: { ...body, ...(prev.status !== 'draft' ? { supplier_id: undefined } : {}), revision: prev.revision } })
      : await m.create.mutateAsync(body);
    lastSaved.current = next;
    setSaved(next);
    return next;
  };

  const fail = (e: unknown, fallback: string) => {
    const msg = purchasingError(e, fallback);
    if (msg && isApiError(e) && e.status === 422) setFormError(e.fieldError('lines') ?? msg);
    else setFormError(msg);
  };

  const saveDraft = () =>
    void handleSubmit(async (v) => {
    setFormError(null);
    setBusy('draft');
    try {
      const next = await persist(v);
      toast(po ? `${next.number} saved.` : `${next.number} saved as a draft.`);
      navigate(`/inventory/purchase-orders/${next.id}`);
    } catch (e) {
      fail(e, 'We couldn’t save this purchase order.');
    } finally {
      setBusy(null);
    }
    })();

  const send = (channel: Exclude<PurchaseOrderSentVia, 'manual'>) => {
    setFormError(null);
    if (channel === 'whatsapp' && !(supplier && whatsappLink(supplier.phone))) return setFormError('This supplier has no phone number. Add one or send the PDF.');
    // Open the WhatsApp tab inside the click so popup blockers allow it; it is pointed at wa.me once the PO is saved.
    const win = channel === 'whatsapp' ? window.open('about:blank', '_blank') : null;
    void handleSubmit(
      async (v) => {
        setBusy('send');
        try {
          const draft = await persist(v);
          const sent = await m.send.mutateAsync({ id: draft.id, input: { sent_via: channel, revision: draft.revision } });
          lastSaved.current = sent;
          if (channel === 'whatsapp') {
            const url = whatsappLink(sent.supplier.phone, whatsappTextOf(sent, scope.store?.name ?? ''))!;
            if (win) {
              win.opener = null;
              win.location.href = url;
            } else window.open(url, '_blank', 'noopener,noreferrer');
          } else {
            saveFile(await api.purchaseOrders.pdf(scope.storeId!, sent.id, sent.number));
          }
          toast(`${sent.number} sent to ${sent.supplier.name}.`);
          navigate(`/inventory/purchase-orders/${sent.id}`);
        } catch (e) {
          win?.close();
          fail(e, 'We couldn’t send this purchase order.');
        } finally {
          setBusy(null);
        }
      },
      () => win?.close(),
    )();
  };

  const recordAdvance = () =>
    void handleSubmit(async (v) => {
    setFormError(null);
    setBusy('advance');
    try {
      setAdvanceOpen(await persist(v));
    } catch (e) {
      fail(e, 'We couldn’t save this purchase order.');
    } finally {
      setBusy(null);
    }
    })();

  const isOrdered = po?.status === 'ordered';
  const number = saved?.number ?? po?.number;

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
        <span>{po ? po.number : 'New'}</span>
      </nav>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-heading-24 text-text-primary">{po ? `Edit ${po.number}` : 'New purchase order'}</h1>
          <p className="text-body text-text-secondary">{[number, isOrdered ? 'Ordered' : 'Draft', 'prices are your cost, never shown to shoppers'].filter(Boolean).join(' · ')}</p>
        </div>
        <ReadOnlyActions className="flex shrink-0 items-center gap-3">
          <Link to={po ? `/inventory/purchase-orders/${po.id}` : '/inventory/purchase-orders'} className="px-2 text-body font-medium text-brand-600 hover:text-brand-700">
            Cancel
          </Link>
          <Button variant="secondary" loading={busy === 'draft'} disabled={!!busy} onClick={saveDraft}>
            {isOrdered ? 'Save changes' : 'Save draft'}
          </Button>
        </ReadOnlyActions>
      </div>
      {locked && <PurchasingPlanNote canSeePlans={scope.canViewBilling} />}

      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          <Card aria-label="Supplier">
            <h2 className="text-body-lg font-medium text-text-primary">Supplier</h2>
            {supplier ? (
              <div className="flex items-center gap-3 rounded-xl border border-brand-100 bg-brand-50 px-4 py-4">
                <SupplierIcon />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-body-lg font-medium text-text-primary">{supplier.name}</span>
                  <span className="truncate text-caption text-text-secondary">{[supplier.contact_name, supplier.phone ? formatBdPhone(supplier.phone) : null, supplier.city].filter(Boolean).join(' · ') || 'No contact details'}</span>
                  <span className="flex flex-wrap gap-x-4 text-caption font-medium">
                    {leadLabel(supplier.lead_time_days) && <span className="text-brand-600">{leadLabel(supplier.lead_time_days)}</span>}
                    <span className="text-brand-600">{plural(supplier.past_orders_count, 'past order')}</span>
                    {supplier.owed_amount !== null && supplier.owed_amount > 0 && <span className="text-warning">You owe {formatBdt(supplier.owed_amount)}</span>}
                  </span>
                </div>
                {!isOrdered && (
                  <button type="button" onClick={() => setPicking('supplier')} className="shrink-0 text-body font-medium text-brand-600 hover:text-brand-700">
                    Change
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-border-strong px-4 py-4">
                <p className="text-body text-text-secondary">Who are you buying from?</p>
                <Button size="sm" onClick={() => setPicking('supplier')}>
                  Choose supplier
                </Button>
                {errors.supplier_id && (
                  <p role="alert" className="text-caption text-danger">
                    {errors.supplier_id.message}
                  </p>
                )}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="po-expected" className="text-body font-medium text-text-primary">
                  Expected by
                </label>
                <input
                  id="po-expected"
                  type="date"
                  min={today}
                  {...register('expected_on')}
                  aria-invalid={errors.expected_on ? true : undefined}
                  className={cn('min-h-11 rounded-md border bg-surface-card px-3 text-body text-text-primary outline-none focus:border-brand-600', errors.expected_on ? 'border-danger' : 'border-border-default')}
                />
                {errors.expected_on && <span className="text-caption text-danger">{errors.expected_on.message}</span>}
              </div>
              <Select id="po-terms" label="Payment terms" value={termsChoice ?? ''} disabled={!supplier} onChange={(e) => setTerms(e.target.value)} hint="From the supplier; changes the advance suggestion only.">
                {!supplier && <option value="">Choose a supplier first</option>}
                {supplier && !TERMS_OPTIONS.some((o) => termsKey({ payment_terms_days: o.terms, advance_percent: o.advance }) === supplierTermsKey) && <option value={supplierTermsKey!}>{termsLabel(supplier)}</option>}
                {TERMS_OPTIONS.map((o) => {
                  const k = termsKey({ payment_terms_days: o.terms, advance_percent: o.advance });
                  return (
                    <option key={o.key} value={k}>
                      {termsLabel({ payment_terms_days: o.terms, advance_percent: o.advance })}
                    </option>
                  );
                })}
              </Select>
              {locs.multi && (
                <Select
                  id="po-receive-at"
                  label="Receive at"
                  value={receiveAtId ?? ''}
                  disabled={receiveAtLocked}
                  onChange={(e) => setReceiveAt(e.target.value)}
                  hint={receiveAtLocked ? 'Locked after the first delivery was received.' : 'Stock goes to this location when you receive it.'}
                >
                  {receiveAtLocked && po && !locs.active.some((l) => l.id === po.location.id) && <option value={po.location.id}>{po.location.name}</option>}
                  {locs.active.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          </Card>

          <Card aria-label="Items" className="gap-0 p-0 sm:p-0">
            <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
              <h2 className="min-w-0 flex-1 text-body-lg font-medium text-text-primary">Items · {fields.length}</h2>
              {suggested.length > 0 && (
                <Button size="sm" variant="secondary" onClick={addSuggested}>
                  Add {suggested.length} suggested
                </Button>
              )}
              <Button size="sm" onClick={() => setPicking('variant')}>
                + Add product
              </Button>
            </div>
            {fields.length === 0 ? (
              <div className="flex flex-col items-center gap-2 border-t border-border-default px-6 py-10 text-center">
                <ClipboardList aria-hidden className="size-6 text-text-muted" />
                <p className="text-body text-text-secondary">Add the products you’re ordering.</p>
                {errors.lines?.message && (
                  <p role="alert" className="text-caption text-danger">
                    {errors.lines.message}
                  </p>
                )}
                {errors.lines?.root?.message && (
                  <p role="alert" className="text-caption text-danger">
                    {errors.lines.root.message}
                  </p>
                )}
              </div>
            ) : (
              <div role="table" aria-label="Items to order">
                <div role="row" className="hidden items-center gap-3 border-y border-border-default bg-surface-subtle px-6 py-2.5 text-caption font-medium text-text-muted uppercase md:flex">
                  <span role="columnheader" className="min-w-0 flex-1">
                    Product
                  </span>
                  <span role="columnheader" className="w-16 text-right">
                    In stock
                  </span>
                  <span role="columnheader" className="w-28">
                    Unit cost
                  </span>
                  <span role="columnheader" className="w-24">
                    Quantity
                  </span>
                  <span role="columnheader" className="w-24 text-right">
                    Line total
                  </span>
                  <span className="w-8" />
                </div>
                {fields.map((f, i) => {
                  const lm = meta[f.variant_id];
                  const label = lm ? `${lm.name}${lm.variant ? ` ${lm.variant}` : ''}` : 'product';
                  const line = lines[i];
                  const err = errors.lines?.[i];
                  return (
                    <div role="row" key={f.key} className="flex flex-col gap-3 border-t border-border-default px-4 py-4 first:border-t-0 md:flex-row md:items-center md:gap-3 md:px-6 md:first:border-t-0">
                      <div role="cell" className="flex min-w-0 flex-1 items-center gap-3">
                        <Thumb src={lm?.image} size={44} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-body font-medium text-text-primary">{lm?.name ?? 'Product'}</span>
                          {lm?.variant && <span className="truncate text-caption text-text-secondary">{lm.variant}</span>}
                          {lm?.lastBought !== null && lm?.lastBought !== undefined && <span className="text-caption text-warning">Last bought at {formatBdt(lm.lastBought)}</span>}
                          {lm && lm.handled > 0 && <span className="text-caption text-text-muted">{formatCount(lm.handled)} already received</span>}
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove ${label}`}
                          disabled={!!lm && lm.handled > 0}
                          onClick={() => remove(i)}
                          className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-subtle hover:text-danger disabled:opacity-30 md:hidden"
                        >
                          <Trash2 aria-hidden className="size-4" />
                        </button>
                      </div>
                      <div role="cell" className={cn('flex items-center justify-between text-body md:w-16 md:justify-end', lm && lm.inStock <= 0 ? 'text-danger' : 'text-text-primary')}>
                        <span className="text-caption text-text-muted md:hidden">In stock</span>
                        {formatCount(lm?.inStock ?? 0)}
                      </div>
                      <div className="grid grid-cols-2 gap-3 md:contents">
                        <div role="cell" className="md:w-28">
                          <Controller
                            control={control}
                            name={`lines.${i}.unit_cost_amount`}
                            render={({ field }) => <MoneyInput aria-label={`Unit cost of ${label}`} value={field.value} onChange={field.onChange} onBlur={field.onBlur} fieldClassName="min-h-10" error={err?.unit_cost_amount?.message} />}
                          />
                        </div>
                        <div role="cell" className="md:w-24">
                          <Controller
                            control={control}
                            name={`lines.${i}.quantity`}
                            render={({ field }) => <QtyInput label={`Quantity of ${label}`} value={field.value ?? null} onChange={field.onChange} error={err?.quantity?.message} />}
                          />
                        </div>
                      </div>
                      <div role="cell" className="flex items-center justify-between md:w-24 md:justify-end">
                        <span className="text-caption text-text-muted md:hidden">Line total</span>
                        <span className="text-body font-semibold text-text-primary">{formatBdt(line ? totals.lineTotal(line) : 0)}</span>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${label}`}
                        disabled={!!lm && lm.handled > 0}
                        onClick={() => remove(i)}
                        className="hidden size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-subtle hover:text-danger disabled:opacity-30 md:flex"
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card aria-label="Note to supplier">
            <label htmlFor="po-notes" className="text-body-lg font-medium text-text-primary">
              Note to supplier
            </label>
            <textarea
              id="po-notes"
              rows={2}
              placeholder="Please pack each piece in its own poly bag with the size label."
              {...register('notes')}
              className="rounded-md border border-border-default px-3 py-2.5 text-body outline-none placeholder:text-text-muted focus:border-brand-600"
            />
            {errors.notes && <span className="text-caption text-danger">{errors.notes.message}</span>}
          </Card>
        </div>

        <Card aria-label="Summary" className="lg:sticky lg:top-4">
          <h2 className="text-body-lg font-medium text-text-primary">Summary</h2>
          <dl className="flex flex-col gap-3 text-body">
            <div className="flex items-center justify-between">
              <dt className="text-text-secondary">Items ({plural(totals.units, 'unit')})</dt>
              <dd className="text-text-primary">{formatBdt(totals.subtotal)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt>
                <label htmlFor="po-shipping" className="text-text-secondary">
                  Transport
                </label>
              </dt>
              <dd className="w-32">
                <Controller control={control} name="shipping_amount" render={({ field }) => <MoneyInput id="po-shipping" value={field.value} onChange={field.onChange} onBlur={field.onBlur} fieldClassName="min-h-9" error={errors.shipping_amount?.message} />} />
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt>
                <label htmlFor="po-discount" className="text-text-secondary">
                  Supplier discount
                </label>
              </dt>
              <dd className="w-32">
                <Controller control={control} name="discount_amount" render={({ field }) => <MoneyInput id="po-discount" value={field.value} onChange={field.onChange} onBlur={field.onBlur} fieldClassName="min-h-9" error={errors.discount_amount?.message} />} />
              </dd>
            </div>
            <div className="flex items-center justify-between border-t border-border-default pt-3">
              <dt className="font-semibold text-text-primary">Total</dt>
              <dd className="text-heading font-semibold text-text-primary" data-testid="po-total">
                {formatBdt(totals.total)}
              </dd>
            </div>
          </dl>

          {split && (
            <div aria-label="Advance" role="group" className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-4 py-3 text-body">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">Advance now ({split.percent}%)</span>
                <span className="font-medium text-text-primary">{formatBdt(split.advance)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">Pay from</span>
                <span className="font-medium text-text-primary">{methodLabel(supplier?.pays_by_method)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">On delivery</span>
                <span className="font-medium text-text-primary">{formatBdt(split.onDelivery)}</span>
              </div>
              <ReadOnlyActions>
                <Button size="sm" variant="secondary" className="mt-1 w-full" loading={busy === 'advance'} disabled={!!busy} onClick={recordAdvance}>
                  Record advance
                </Button>
              </ReadOnlyActions>
            </div>
          )}

          <p role="note" className="flex gap-2 rounded-lg bg-brand-50 px-3 py-2.5 text-caption text-brand-700">
            <ClipboardList aria-hidden className="mt-0.5 size-4 shrink-0" />
            Stock value goes up by {formatBdt(totals.total)} when received. Cost prices update automatically.
          </p>

          {formError && (
            <p role="alert" className="flex gap-2 rounded-lg bg-danger-bg px-3 py-2.5 text-caption text-danger">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {formError}
            </p>
          )}

          <ReadOnlyActions className="flex flex-col gap-2 [&>div:first-child]:flex">
            <Menu
              label="Send to supplier"
              align="end"
              disabled={!!busy}
              className="w-full min-w-[220px]"
              triggerClassName={cn(buttonVariants(), 'h-11 w-full gap-2 bg-brand-600 text-text-inverse hover:bg-brand-700')}
              trigger={busy === 'send' ? 'Sending…' : isOrdered ? 'Save and send again' : 'Send to supplier'}
              entries={[
                { key: 'whatsapp', label: 'WhatsApp', hint: supplier?.phone ? 'Opens WhatsApp with the order' : 'Supplier has no phone number', icon: <MessageCircle />, disabled: !supplier?.phone, onSelect: () => void send('whatsapp') },
                { key: 'pdf', label: 'PDF', hint: 'Download to share or print', icon: <FileText />, onSelect: () => void send('pdf') },
              ]}
            />
            <p className="text-caption text-text-muted">Sending marks the order as ordered.</p>
          </ReadOnlyActions>
        </Card>
      </div>

      {picking === 'supplier' && <SupplierPickerDialog selectedId={supplier?.id} onClose={() => setPicking(null)} onPick={pickSupplier} onAdd={() => setPicking('add-supplier')} />}
      {picking === 'add-supplier' && <SupplierFormDialog supplier={null} onClose={() => setPicking(null)} onSaved={pickSupplier} />}
      {picking === 'variant' && (
        <VariantPickerDialog
          exclude={lines.map((l) => l.variant_id)}
          onClose={() => setPicking(null)}
          onPick={(item) => {
            setMeta((mm) => ({ ...mm, [item.variant_id]: metaOfItem(item) }));
            append({ variant_id: item.variant_id, unit_cost_amount: item.cost_amount ?? null, quantity: 1 });
            setPicking(null);
          }}
        />
      )}
      {advanceOpen && split && supplier && (
        <RecordPaymentDialog
          title="Record advance"
          supplier={{ id: supplier.id, name: supplier.name, pays_by_method: supplier.pays_by_method as SupplierPaymentMethod | null }}
          purchaseOrders={[{ id: advanceOpen.id, number: advanceOpen.number }]}
          defaultPoId={advanceOpen.id}
          defaultAmount={split.advance}
          onClose={() => setAdvanceOpen(null)}
        />
      )}
    </>
  );
}

function whatsappTextOf(po: PurchaseOrderDetail, storeName: string) {
  return whatsappText(whatsappPoOf(po, storeName));
}

/** Whole-number quantity field (Bangla digits allowed); emits null (empty) or NaN (invalid) for the schema. */
function QtyInput({ label, value, onChange, error }: { label: string; value: number | null; onChange: (v: number | null) => void; error?: string }) {
  const [text, setText] = useState(value === null || Number.isNaN(value) ? '' : String(value));
  return (
    <div className="flex flex-col gap-1">
      <input
        aria-label={label}
        inputMode="numeric"
        value={text}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseQty(e.target.value));
        }}
        className={cn('min-h-10 w-full rounded-md border bg-surface-card px-3 text-body text-text-primary outline-none focus:border-brand-600', error ? 'border-danger' : 'border-border-default')}
      />
      {error && <span className="text-caption text-danger">{error}</span>}
    </div>
  );
}

