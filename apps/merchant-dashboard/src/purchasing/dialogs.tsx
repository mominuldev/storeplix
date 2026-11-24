import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import {
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  type InventoryItem,
  type PurchaseOrderDetail,
  type Supplier,
  type SupplierPaymentMethod,
} from '@storeplix/types';
import { Button, Input, Modal, MoneyInput, Select, Toggle } from '@storeplix/ui';
import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Controller, useForm, type FieldPath } from 'react-hook-form';
import { formatBdt, formatCount } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { Cell2, Thumb } from '../catalog/ui';
import { newIdempotencyKey } from '../commerce/format';
import { toast } from '../online-store/components/Toast';
import { localToday } from '../reports/range';
import { SupplierPickerDialog, VariantPickerDialog } from './components';
import { emptySupplier, parseQty, paymentSchema, poTotals, supplierInputOf, supplierSchema, supplierValuesOf, type PaymentValues, type SupplierValues, purchasingError } from './purchasing';
import { usePurchaseOrderMutations, useSupplierMutations } from './queries';

// PHASE-8-8B composed dialogs (§10.2–§10.4): Record payment, Add/Edit supplier, Quick purchase.

const FormError = ({ message }: { message: string | null }) =>
  message ? (
    <p role="alert" className="text-caption text-danger">
      {message}
    </p>
  ) : null;

// ---------- Record payment ----------

export function RecordPaymentDialog({
  supplier,
  purchaseOrders = [],
  defaultPoId = '',
  defaultAmount = null,
  defaultMethod,
  title = 'Record payment',
  onClose,
  onDone,
}: {
  supplier: { id: string; name: string; pays_by_method?: SupplierPaymentMethod | null };
  purchaseOrders?: { id: string; number: string }[];
  defaultPoId?: string;
  defaultAmount?: number | null;
  defaultMethod?: SupplierPaymentMethod | null;
  title?: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const scope = useStoreScope();
  const today = localToday(scope.store?.timezone);
  const { recordPayment } = useSupplierMutations();
  const [error, setError] = useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setError: setFieldError,
    formState: { errors },
  } = useForm<PaymentValues>({
    resolver: zodResolver(paymentSchema(today)),
    defaultValues: { amount: defaultAmount, method: defaultMethod ?? supplier.pays_by_method ?? 'cash', paid_on: today, purchase_order_id: defaultPoId, note: '' },
  });
  const submit = handleSubmit((v) => {
    setError(null);
    recordPayment.mutate(
      { id: supplier.id, input: { amount: v.amount!, method: v.method, paid_on: v.paid_on, purchase_order_id: v.purchase_order_id || null, note: v.note.trim() || null } },
      {
        onSuccess: (p) => {
          toast(`${formatBdt(p.amount)} paid to ${supplier.name} recorded.`);
          onDone?.();
          onClose();
        },
        onError: (e) => {
          if (isApiError(e) && e.status === 422) {
            for (const f of ['amount', 'paid_on', 'method', 'note', 'purchase_order_id'] as FieldPath<PaymentValues>[]) {
              const m = e.fieldError(f);
              if (m) setFieldError(f, { message: m });
            }
          }
          setError(purchasingError(e, 'We couldn’t record this payment.'));
        },
      },
    );
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={`Money you paid to ${supplier.name}. This is a record only — no money is sent.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={recordPayment.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="record-payment-form" loading={recordPayment.isPending}>
            Record payment
          </Button>
        </>
      }
    >
      <form id="record-payment-form" noValidate className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <Controller control={control} name="amount" render={({ field }) => <MoneyInput id="payment-amount" label="Amount" value={field.value} onChange={field.onChange} onBlur={field.onBlur} error={errors.amount?.message} />} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select id="payment-method" label="Paid by" {...register('method')} error={errors.method?.message}>
            {SUPPLIER_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {SUPPLIER_PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
          <Input id="payment-date" type="date" label="Paid on" max={today} {...register('paid_on')} error={errors.paid_on?.message} />
        </div>
        {purchaseOrders.length > 0 && (
          <Select id="payment-po" label="For purchase order" {...register('purchase_order_id')} error={errors.purchase_order_id?.message}>
            <option value="">No specific order</option>
            {purchaseOrders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.number}
              </option>
            ))}
          </Select>
        )}
        <Input id="payment-note" label="Note (optional)" placeholder="bKash TrxID or cheque number" {...register('note')} error={errors.note?.message} />
        <FormError message={error} />
      </form>
    </Modal>
  );
}

// ---------- Add / edit supplier ----------

export function SupplierFormDialog({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved?: (s: Supplier) => void }) {
  const { create, update } = useSupplierMutations();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError: setFieldError,
    formState: { errors },
  } = useForm<SupplierValues>({ resolver: zodResolver(supplierSchema), defaultValues: supplier ? supplierValuesOf(supplier) : emptySupplier() });
  const saving = create.isPending || update.isPending;
  const num = (v: unknown) => (typeof v !== 'string' ? (v ?? null) : v.trim() === '' ? null : Number(v));
  const submit = handleSubmit((v) => {
    setError(null);
    const input = supplierInputOf(v);
    const opts = {
      onSuccess: (s: Supplier) => {
        toast(supplier ? 'Supplier saved.' : `${s.name} added.`);
        onSaved?.(s);
        onClose();
      },
      onError: (e: unknown) => {
        if (isApiError(e) && e.status === 422) {
          for (const f of Object.keys(emptySupplier()) as FieldPath<SupplierValues>[]) {
            const m = e.fieldError(f);
            if (m) setFieldError(f, { message: m });
          }
        }
        setError(purchasingError(e, 'We couldn’t save this supplier.'));
      },
    };
    if (supplier) update.mutate({ id: supplier.id, input }, opts);
    else create.mutate(input, opts);
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={supplier ? 'Edit supplier' : 'Add supplier'}
      description="Who you buy from. Only your team sees this."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="supplier-form" loading={saving}>
            {supplier ? 'Save supplier' : 'Add supplier'}
          </Button>
        </>
      }
    >
      <form id="supplier-form" noValidate className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <Input id="supplier-name" label="Supplier name" placeholder="Tangail Weavers" {...register('name')} error={errors.name?.message} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input id="supplier-contact" label="Contact person (optional)" placeholder="Karim Mia" {...register('contact_name')} error={errors.contact_name?.message} />
          <Input id="supplier-phone" label="Phone (optional)" inputMode="tel" placeholder="01711-889900" {...register('phone')} error={errors.phone?.message} />
          <Input id="supplier-city" label="City / area (optional)" placeholder="Tangail" {...register('city')} error={errors.city?.message} />
          <Input id="supplier-supplies" label="What they supply (optional)" placeholder="Jamdani, saree" {...register('supplies')} error={errors.supplies?.message} />
          <Input id="supplier-terms" label="Payment terms (days after delivery)" inputMode="numeric" placeholder="15" {...register('payment_terms_days', { setValueAs: num })} error={errors.payment_terms_days?.message} />
          <Input id="supplier-advance" label="Advance (%)" inputMode="numeric" placeholder="50" {...register('advance_percent', { setValueAs: num })} error={errors.advance_percent?.message} />
          <Input id="supplier-lead" label="Lead time (days)" inputMode="numeric" placeholder="5" {...register('lead_time_days', { setValueAs: num })} error={errors.lead_time_days?.message} />
          <Select id="supplier-pays-by" label="Pay by" {...register('pays_by_method')} error={errors.pays_by_method?.message}>
            <option value="">Not set</option>
            {SUPPLIER_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {SUPPLIER_PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </div>
        <Input id="supplier-account" label="Pay to (bKash number or account, optional)" placeholder="01712-889900" {...register('pays_by_account')} error={errors.pays_by_account?.message} />
        <Input id="supplier-notes" label="Notes (optional)" {...register('notes')} error={errors.notes?.message} />
        <FormError message={error} />
      </form>
    </Modal>
  );
}

// ---------- Quick purchase (P88B-13) ----------

interface QuickLine {
  item: InventoryItem;
  unit: number | null;
  qty: string;
  damaged: string;
}

/** "Quick purchase" (composed): supplier, lines, transport, discount, payment → one received PO in one request. */
export function QuickPurchaseDialog({ onClose, onDone }: { onClose: () => void; onDone: (po: PurchaseOrderDetail) => void }) {
  const scope = useStoreScope();
  const today = localToday(scope.store?.timezone);
  const { quick } = usePurchaseOrderMutations();
  const key = useRef(newIdempotencyKey());
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [picking, setPicking] = useState<'supplier' | 'variant' | 'add-supplier' | null>(null);
  const [lines, setLines] = useState<QuickLine[]>([]);
  const [shipping, setShipping] = useState<number | null>(null);
  const [discount, setDiscount] = useState<number | null>(null);
  const [paid, setPaid] = useState(true);
  const [payAmount, setPayAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<SupplierPaymentMethod>('cash');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const formLines = lines.map((l) => ({ variant_id: l.item.variant_id, unit_cost_amount: l.unit, quantity: parseQty(l.qty) }));
  const totals = poTotals(formLines, shipping, discount);
  const lineError = (l: QuickLine) => {
    const q = parseQty(l.qty);
    const d = parseQty(l.damaged) ?? 0;
    if (q === null || !Number.isInteger(q) || q < 1) return 'Enter how many pieces came.';
    if (!Number.isInteger(d) || d < 0) return 'Damaged must be a whole number.';
    if (d > q) return 'Damaged can’t be more than the pieces.';
    if (l.unit === null || !Number.isFinite(l.unit)) return 'Enter the unit cost.';
    return null;
  };
  const payEffective = payAmount ?? (totals.total > 0 ? totals.total : null);
  const invalid = !supplier || lines.length === 0 || lines.some((l) => lineError(l)) || (paid && (payEffective === null || !Number.isFinite(payEffective) || payEffective < 1)) || totals.discount > totals.subtotal + totals.shipping;

  const submit = () => {
    setTouched(true);
    setError(null);
    if (invalid || !supplier) return;
    quick.mutate(
      {
        key: key.current,
        input: {
          supplier_id: supplier.id,
          lines: lines.map((l) => ({ variant_id: l.item.variant_id, unit_cost_amount: l.unit!, quantity: parseQty(l.qty)!, damaged: parseQty(l.damaged) ?? 0 })),
          shipping_amount: totals.shipping,
          discount_amount: totals.discount,
          payment: paid ? { amount: payEffective!, method, paid_on: today } : null,
          supplier_invoice_ref: invoiceRef.trim() || null,
        },
      },
      {
        onSuccess: (po) => {
          toast(`${po.number} recorded. ${formatCount(po.units_received)} units added to stock.`);
          onDone(po);
        },
        onError: (e) => setError(purchasingError(e, 'We couldn’t record this purchase.')),
      },
    );
  };

  if (picking === 'supplier')
    return (
      <SupplierPickerDialog
        selectedId={supplier?.id}
        onClose={() => setPicking(null)}
        onAdd={() => setPicking('add-supplier')}
        onPick={(s) => {
          setSupplier(s);
          if (s.pays_by_method) setMethod(s.pays_by_method);
          setPicking(null);
        }}
      />
    );
  if (picking === 'add-supplier')
    return (
      <SupplierFormDialog
        supplier={null}
        onClose={() => setPicking(null)}
        onSaved={(s) => {
          setSupplier(s);
          setPicking(null);
        }}
      />
    );
  if (picking === 'variant')
    return (
      <VariantPickerDialog
        exclude={lines.map((l) => l.item.variant_id)}
        onClose={() => setPicking(null)}
        onPick={(item) => {
          setLines((ls) => [...ls, { item, unit: item.cost_amount, qty: '1', damaged: '' }]);
          setPicking(null);
        }}
      />
    );

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Quick purchase"
      description="Bought and received today, for example at a wholesale market. Stock goes in now and cost prices update."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={quick.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={quick.isPending}>
            Record purchase
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-default px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-caption text-text-muted">Supplier</span>
            <span className="truncate text-body font-medium text-text-primary">{supplier?.name ?? 'No supplier chosen'}</span>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setPicking('supplier')}>
            {supplier ? 'Change' : 'Choose supplier'}
          </Button>
        </div>
        {touched && !supplier && <FormError message="Choose a supplier." />}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-body font-medium text-text-primary">Items · {lines.length}</h3>
            <Button size="sm" onClick={() => setPicking('variant')}>
              + Add product
            </Button>
          </div>
          {lines.length === 0 ? (
            <p className="rounded-lg bg-surface-subtle px-4 py-3 text-body text-text-muted">Add what you bought.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-default rounded-lg border border-border-default">
              {lines.map((l, idx) => {
                const variant = l.item.title !== 'Default' ? l.item.title : null;
                const err = touched ? lineError(l) : null;
                const set = (patch: Partial<QuickLine>) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
                return (
                  <li key={l.item.variant_id} className="flex flex-col gap-2 px-3 py-3">
                    <div className="flex items-center gap-3">
                      <Thumb src={l.item.product.image?.url} size={36} />
                      <Cell2 top={l.item.product.name} bottom={variant ?? undefined} />
                      <button type="button" aria-label={`Remove ${l.item.product.name}${variant ? ` ${variant}` : ''}`} onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))} className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-subtle hover:text-danger">
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <MoneyInput aria-label={`Unit cost of ${l.item.product.name}`} value={l.unit} onChange={(v) => set({ unit: v })} fieldClassName="min-h-10" />
                      <Input aria-label={`Pieces of ${l.item.product.name}`} inputMode="numeric" placeholder="Pieces" value={l.qty} onChange={(e) => set({ qty: e.target.value })} fieldClassName="min-h-10" />
                      <Input aria-label={`Damaged pieces of ${l.item.product.name}`} inputMode="numeric" placeholder="Damaged" value={l.damaged} onChange={(e) => set({ damaged: e.target.value })} fieldClassName="min-h-10" />
                    </div>
                    <FormError message={err} />
                  </li>
                );
              })}
            </ul>
          )}
          {touched && lines.length === 0 && <FormError message="Add at least one product." />}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <MoneyInput id="quick-shipping" label="Transport" value={shipping} onChange={setShipping} />
          <MoneyInput id="quick-discount" label="Supplier discount" value={discount} onChange={setDiscount} error={totals.discount > totals.subtotal + totals.shipping ? 'More than the items plus transport.' : undefined} />
          <Input id="quick-invoice" label="Supplier invoice no. (optional)" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} maxLength={60} />
        </div>

        <div className="flex flex-col gap-3 rounded-lg bg-surface-subtle px-4 py-3">
          <div className="flex items-center justify-between text-body">
            <span className="text-text-secondary">Total</span>
            <span className="font-semibold text-text-primary">{formatBdt(totals.total)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-body text-text-primary">I paid for this now</span>
            <Toggle label="I paid for this now" checked={paid} onChange={setPaid} />
          </div>
          {paid && (
            <div className="grid gap-3 sm:grid-cols-2">
              <MoneyInput
                id="quick-paid"
                label="Amount paid"
                value={payEffective}
                onChange={setPayAmount}
                error={touched && (payEffective === null || !Number.isFinite(payEffective) || payEffective < 1) ? 'Enter the amount paid.' : undefined}
              />
              <Select id="quick-method" label="Paid by" value={method} onChange={(e) => setMethod(e.target.value as SupplierPaymentMethod)}>
                {SUPPLIER_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {SUPPLIER_PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <FormError message={error} />
      </div>
    </Modal>
  );
}
