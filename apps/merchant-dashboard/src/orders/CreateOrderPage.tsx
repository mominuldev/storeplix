import { isApiError } from '@storeplix/api-client';
import type { AddressInput, ManualOrderInput, MediaRef, OrderChannel, OrderQuote, Product, ProductSummary } from '@storeplix/types';
import { Button, Checkbox, Chip, cn, Input, MoneyInput, Select } from '@storeplix/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, Minus, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatBdt, formatCount } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { SearchBox, Thumb, useDebounced } from '../catalog/ui';
import { addressProblems, emptyAddress, type AddressErrors } from '../commerce/address';
import { AddressFields } from '../commerce/AddressFields';
import { daysRange, manualChannels, newIdempotencyKey, orderChannelLabels, ordinal } from '../commerce/format';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';
import { normalizeBdPhone } from '../lib/phone';
import { FormAlert } from '../onboarding/AuthShell';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { Card } from './OrderDetailPage';

// Figma Create order 39:14382 (mobile 32:6124). Contract §9 / P5-19: channel chips, phone first (returning-customer
// hint from this shop), name, address, product picker with variant + qty + stock hint, delivery charge from the
// address with "Change" (override), coupon, live summary from POST /orders/quote (debounced 300 ms), COD, note,
// "Send order SMS to buyer". The Idempotency-Key is created once per form session and reused on retries (§9.1).
// Not built (§11): Paste chat message (AI), barcode scan, draft saving, payment links, assign to, courier, print.

interface Line {
  variant_id: string;
  quantity: number;
  product_name: string;
  variant_title: string;
  price_amount: number;
  image: MediaRef | null;
  available: number | null; // null = untracked or backorder
}

export const QUOTE_DEBOUNCE_MS = 300;

export function CreateOrderPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const scope = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [channel, setChannel] = useState<Exclude<OrderChannel, 'website'>>('facebook');
  const [phone, setPhone] = useState(params.get('phone') ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState<AddressInput>(emptyAddress);
  const [lines, setLines] = useState<Line[]>([]);
  const [coupon, setCoupon] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [override, setOverride] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [errors, setErrors] = useState<AddressErrors & Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const msisdn = normalizeBdPhone(phone);
  const returning = useQuery({
    queryKey: [...keys.customers(scope, { q: msisdn }), 'match'],
    queryFn: () => api.customers.list(scope.storeId!, { q: msisdn!, per_page: 5 }),
    enabled: !!scope.storeId && !!msisdn,
    select: (r) => r.data.find((c) => c.phone === msisdn) ?? null,
  });
  const match = returning.data ?? null;

  const input: ManualOrderInput = {
    channel,
    contact: { name: name.trim() || match?.name || '', phone: msisdn ?? phone.trim(), email: email.trim() || null },
    shipping_address: address,
    items: lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity })),
    payment_method: 'cod',
    coupon_code: appliedCoupon,
    shipping_amount_override: overriding && override !== null && Number.isFinite(override) ? override : null,
    customer_id: match?.id ?? null,
    customer_note: note.trim() || null,
    notify_customer: notify,
  };
  // Debounce the serialised input (a string compares by value, so re-renders don't restart the timer).
  const quoteKey = useDebounced(JSON.stringify(input), QUOTE_DEBOUNCE_MS);
  const quoteInput = useMemo(() => JSON.parse(quoteKey) as ManualOrderInput, [quoteKey]);
  const quote = useQuery({
    queryKey: [scope.tenantId, scope.storeId, 'order-quote', quoteKey],
    queryFn: ({ signal }) => api.orders.quote(scope.storeId!, quoteInput, { signal }),
    enabled: !!scope.storeId && quoteInput.items.length > 0,
    retry: false,
    staleTime: 30_000,
  });
  const q: OrderQuote | undefined = quote.data;

  const create = useMutation({
    mutationFn: () => api.orders.create(scope.storeId!, input, idempotencyKey),
    onSuccess: async (order) => {
      toast(`${order.number} created.`);
      await invalidate.afterOrderChange(order.id, order.customer.id);
      navigate(`/orders/${order.id}`, { replace: true });
    },
    onError: (e) => {
      // 402: the single app-wide PlanLimitDialog (AppShell) opens; this page renders inside AppShell.
      if (handlePlanLimit(e)) return;
      if (isApiError(e) && e.status === 422 && e.details) {
        const next: Record<string, string> = {};
        for (const [k, m] of Object.entries(e.details)) next[k.replace(/^contact\./, '').replace(/^shipping_address\./, '')] = m[0] ?? '';
        setErrors(next);
        return setFormError(e.code === 'out_of_stock' ? 'Some items don’t have enough stock.' : e.code === 'coupon_invalid' ? (next.coupon_code ?? e.message) : 'Some fields need attention.');
      }
      setFormError(errorMessage(e, 'We couldn’t create the order. Try again — it won’t be created twice.'));
    },
  });

  const submit = () => {
    const next: Record<string, string | undefined> = { ...addressProblems(address) };
    if (!msisdn) next.phone = 'Enter a Bangladeshi mobile number (01XXXXXXXXX).';
    if (input.contact.name.length < 2) next.name = 'Enter the customer’s name.';
    if (!lines.length) next.items = 'Add at least one product.';
    if (overriding && (override === null || !Number.isFinite(override) || override > 1_000_000)) next.shipping_amount_override = 'Enter a delivery charge up to ৳ 10,000.';
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    setErrors(clean);
    if (Object.keys(clean).length) return setFormError('Some fields need attention.');
    setFormError(null);
    create.mutate();
  };

  const subtotal = q?.subtotal_amount ?? lines.reduce((s, l) => s + l.price_amount * l.quantity, 0);
  const issueFor = (variantId: string) => q?.lines.find((l) => l.variant_id === variantId)?.issue ?? null;

  return (
    <>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-body font-medium text-text-secondary">
        <Link to="/orders" className="text-brand-600 hover:text-brand-700">
          Orders
        </Link>
        <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
        <span>Create order</span>
      </nav>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-heading-32 text-text-primary">Create order</h1>
        <p className="text-body text-text-secondary">Take an order from a chat, call or walk-in. Start with the phone number.</p>
      </div>
      {formError && <FormAlert>{formError}</FormAlert>}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex flex-col gap-5">
          <Card title="Where did this order come from?" label="Source">
            <div role="radiogroup" aria-label="Order source" className="flex flex-wrap gap-2">
              {manualChannels.map((c) => (
                <Chip key={c} role="radio" aria-checked={channel === c} selected={channel === c} onClick={() => setChannel(c)}>
                  {orderChannelLabels[c]}
                </Chip>
              ))}
            </div>
          </Card>

          <Card
            title="Customer"
            actions={
              match ? (
                <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-caption font-medium text-brand-700">
                  Returning · {match.orders_count > 0 ? `${ordinal(match.orders_count + 1)} order` : 'no orders yet'}
                </span>
              ) : undefined
            }
          >
            <Input id="co-phone" label="Phone number" inputMode="tel" placeholder="01712-345678" value={phone} error={errors.phone} onChange={(e) => setPhone(e.target.value)} />
            {match && (
              <p className="rounded-md bg-surface-subtle px-3 py-2.5 text-caption text-text-secondary">
                <strong className="text-text-primary">{match.name}</strong> · {formatCount(match.delivered_orders_count)} of {formatCount(match.orders_count)} delivered
                {match.returned_orders_count ? ` · ${formatCount(match.returned_orders_count)} returned` : ''} · spent {formatBdt(match.total_spent_amount)} in this shop{' '}
                <Link to={`/customers/${match.id}`} className="font-medium text-brand-600">
                  View
                </Link>
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Input id="co-name" label="Name" placeholder={match?.name ?? ''} value={name} maxLength={120} error={errors.name} onChange={(e) => setName(e.target.value)} />
              <Input id="co-email" label="Email (optional)" type="email" value={email} maxLength={254} error={errors.email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </Card>

          <Card title="Delivery address">
            <AddressFields value={address} onChange={setAddress} errors={errors} idPrefix="co" />
          </Card>

          <ProductsCard lines={lines} setLines={setLines} error={errors.items} issueFor={issueFor} />

          <Card title="Note">
            <textarea
              aria-label="Customer note"
              rows={3}
              maxLength={500}
              placeholder="Please call before delivery"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-md border border-border-default px-3 py-2.5 text-body outline-none placeholder:text-text-muted focus:border-brand-600"
            />
          </Card>
        </div>

        <div className="flex flex-col gap-5 lg:sticky lg:top-20">
          <Card title="Order summary">
            <dl className="flex flex-col gap-2 text-body">
              <SummaryRow label="Subtotal" value={formatBdt(subtotal)} />
              <div className="flex items-start justify-between gap-3">
                <dt className="flex flex-col text-text-secondary">
                  <span>Delivery{q?.zone ? ` · ${q.zone.zone_name}` : ''}</span>
                  {q?.zone && <span className="text-caption text-text-muted">{daysRange(q.zone.min_days, q.zone.max_days)}</span>}
                  <button type="button" className="self-start text-caption font-medium text-brand-600" onClick={() => setOverriding((o) => !o)}>
                    {overriding ? 'Use the zone charge' : 'Change'}
                  </button>
                </dt>
                <dd className="text-text-primary">{q ? (q.shipping_amount === 0 ? 'Free' : formatBdt(q.shipping_amount)) : '—'}</dd>
              </div>
              {overriding && <MoneyInput id="co-override" label="Delivery charge" value={override} onChange={setOverride} error={errors.shipping_amount_override} />}
              <div className="flex items-end gap-2">
                <Input id="co-coupon" label="Coupon" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} containerClassName="flex-1" error={appliedCoupon ? (q?.coupon_error ?? errors.coupon_code) : undefined} />
                {appliedCoupon ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setAppliedCoupon(null);
                      setCoupon('');
                    }}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button variant="secondary" disabled={!coupon.trim()} onClick={() => setAppliedCoupon(coupon.trim())}>
                    Apply
                  </Button>
                )}
              </div>
              {q && q.discount_amount > 0 && <SummaryRow label={`Discount${appliedCoupon ? ` · ${appliedCoupon}` : ''}`} value={`− ${formatBdt(q.discount_amount)}`} className="text-success" />}
              <div className="flex items-center justify-between border-t border-border-default pt-3 text-body-lg font-semibold text-text-primary">
                <dt>Total</dt>
                <dd aria-label="Order total">{q ? formatBdt(q.total_amount) : formatBdt(subtotal)}</dd>
              </div>
              <p className="text-caption text-text-muted" aria-live="polite">
                {quote.isFetching ? 'Updating…' : quote.isError ? 'Add the phone, name and address to see the delivery charge.' : q ? 'Cash on delivery · collected at the door' : 'Add products to see the total.'}
              </p>
            </dl>
          </Card>
          <Card title="How will the buyer pay?" label="Payment">
            <label className="flex items-center gap-3 rounded-lg border-2 border-brand-600 bg-brand-50 px-3.5 py-3">
              <input type="radio" checked readOnly className="accent-brand-600" />
              <span className="flex flex-col gap-0.5">
                <span className="text-body font-medium text-text-primary">Cash on delivery</span>
                <span className="text-caption text-text-secondary">The buyer pays at the door</span>
              </span>
            </label>
            <p className="text-caption text-text-muted">Advance and payment links are coming soon.</p>
            <Checkbox label="Send order SMS to buyer" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          </Card>
          <Button className="w-full" loading={create.isPending} onClick={submit}>
            Create order
          </Button>
        </div>
      </div>
    </>
  );
}

function SummaryRow({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 text-text-secondary', className)}>
      <dt>{label}</dt>
      <dd className={className ?? 'text-text-primary'}>{value}</dd>
    </div>
  );
}

type Variant = Product['variants'][number];

/** Product search + variant pick (Create order 39:14382); reused by Edit items 144:46654. */
export function ProductPicker({ onAdd, idPrefix = 'co' }: { onAdd: (product: Product, variant: Variant) => void; idPrefix?: string }) {
  const scope = useStoreScope();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [picking, setPicking] = useState<string | null>(null);
  const results = useQuery({
    queryKey: keys.products(scope, { q: debounced, status: ['active', 'draft'], per_page: 8, picker: true }),
    queryFn: () => api.products.list(scope.storeId!, { q: debounced, status: ['active', 'draft'], per_page: 8 }),
    enabled: !!scope.storeId && debounced.trim().length > 0,
  });
  const product = useQuery({
    queryKey: keys.product(scope, picking ?? undefined),
    queryFn: () => api.products.get(scope.storeId!, picking!),
    enabled: !!scope.storeId && !!picking,
  });
  const add = (p: Product, variantId: string) => {
    const v = p.variants.find((x) => x.id === variantId);
    if (!v) return;
    onAdd(p, v);
    setPicking(null);
    setSearch('');
  };
  return (
    <>
      <div className="relative">
        <SearchBox value={search} onChange={setSearch} placeholder="Search by name or SKU" label="Search products" />
        {debounced.trim() && !picking && (
          <ul aria-label="Product results" className="absolute inset-x-0 top-11 z-10 max-h-72 overflow-y-auto rounded-md border border-border-default bg-surface-card shadow-elevation-1">
            {results.isPending && <li className="px-3 py-3 text-caption text-text-muted">Searching…</li>}
            {results.data?.data.length === 0 && <li className="px-3 py-3 text-caption text-text-muted">No products match “{debounced}”.</li>}
            {results.data?.data.map((p: ProductSummary) => (
              <li key={p.id}>
                <button type="button" onClick={() => setPicking(p.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-subtle">
                  <Thumb src={p.image?.url} size={36} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-medium text-text-primary">{p.name}</span>
                    <span className="text-caption text-text-muted">
                      {formatBdt(p.price_min_amount)}
                      {p.stock.tracked ? ` · ${formatCount(p.stock.available)} in stock` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {picking && (
        <div className="flex flex-col gap-2 rounded-md border border-border-default p-3">
          {product.isPending ? (
            <span className="text-caption text-text-muted">Loading variants…</span>
          ) : product.data ? (
            <VariantPicker product={product.data} idPrefix={idPrefix} onPick={(id) => add(product.data!, id)} onCancel={() => setPicking(null)} />
          ) : (
            <span className="text-caption text-danger">We couldn’t load this product.</span>
          )}
        </div>
      )}
    </>
  );
}

function ProductsCard({ lines, setLines, error, issueFor }: { lines: Line[]; setLines: (fn: (l: Line[]) => Line[]) => void; error?: string; issueFor: (variantId: string) => string | null }) {
  const add = (p: Product, v: Variant) =>
    setLines((ls) =>
      ls.some((l) => l.variant_id === v.id)
        ? ls.map((l) => (l.variant_id === v.id ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l))
        : [
            ...ls,
            {
              variant_id: v.id,
              quantity: 1,
              product_name: p.name,
              variant_title: v.title,
              price_amount: v.price_amount,
              image: p.images.find((i) => i.media_id === v.image_media_id)?.media ?? p.image,
              available: v.track_inventory && !v.allow_backorder ? v.inventory.available : null,
            },
          ].slice(0, 50),
    );

  return (
    <Card title={`Products · ${lines.length}`} label="Products">
      <ProductPicker onAdd={add} />
      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border-default">
        {lines.map((l) => {
          const issue = issueFor(l.variant_id);
          const low = l.available !== null && l.quantity > l.available;
          return (
            <li key={l.variant_id} className="flex items-center gap-3 py-3">
              <Thumb src={l.image?.url} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-semibold text-text-primary">{l.product_name}</span>
                <span className="truncate text-caption text-text-muted">
                  {l.variant_title !== 'Default' ? `${l.variant_title} · ` : ''}
                  {formatBdt(l.price_amount)} each
                </span>
                {issue === 'unavailable' ? (
                  <span className="text-caption text-danger">No longer available</span>
                ) : issue === 'insufficient_stock' || low ? (
                  <span className="text-caption text-danger">Only {formatCount(Math.max(0, l.available ?? 0))} in stock</span>
                ) : l.available !== null ? (
                  <span className="text-caption text-success">{formatCount(l.available)} in stock</span>
                ) : null}
              </div>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Fewer ${l.product_name}`}
                  disabled={l.quantity <= 1}
                  onClick={() => setLines((ls) => ls.map((x) => (x.variant_id === l.variant_id ? { ...x, quantity: x.quantity - 1 } : x)))}
                  className="flex size-8 items-center justify-center rounded-md border border-border-default disabled:opacity-40"
                >
                  <Minus aria-hidden className="size-4" />
                </button>
                <span className="w-8 text-center text-body font-semibold">{l.quantity}</span>
                <button
                  type="button"
                  aria-label={`More ${l.product_name}`}
                  disabled={l.quantity >= 99}
                  onClick={() => setLines((ls) => ls.map((x) => (x.variant_id === l.variant_id ? { ...x, quantity: x.quantity + 1 } : x)))}
                  className="flex size-8 items-center justify-center rounded-md border border-border-default disabled:opacity-40"
                >
                  <Plus aria-hidden className="size-4" />
                </button>
              </span>
              <span className="hidden w-20 text-right text-body font-semibold text-text-primary sm:inline">{formatBdt(l.price_amount * l.quantity)}</span>
              <button type="button" aria-label={`Remove ${l.product_name}`} onClick={() => setLines((ls) => ls.filter((x) => x.variant_id !== l.variant_id))} className="rounded-sm p-1 text-text-muted hover:text-danger">
                <Trash2 aria-hidden className="size-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function VariantPicker({ product, onPick, onCancel, idPrefix }: { product: Product; onPick: (variantId: string) => void; onCancel: () => void; idPrefix: string }) {
  const enabled = useMemo(() => product.variants.filter((v) => v.is_enabled), [product]);
  const [variantId, setVariantId] = useState(enabled[0]?.id ?? '');
  if (enabled.length === 0) return <span className="text-caption text-danger">{product.name} has no variants for sale.</span>;
  const stockLabel = (v: Product['variants'][number]) => (!v.track_inventory ? '' : v.allow_backorder ? ' · backorder' : ` · ${v.inventory.available} in stock`);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <span className="w-full text-body font-semibold text-text-primary">{product.name}</span>
      {enabled.length > 1 ? (
        <Select id={`${idPrefix}-variant`} label="Variant" value={variantId} onChange={(e) => setVariantId(e.target.value)} containerClassName="flex-1">
          {enabled.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title} · {formatBdt(v.price_amount)}
              {stockLabel(v)}
            </option>
          ))}
        </Select>
      ) : (
        <span className="flex-1 text-caption text-text-muted">
          {formatBdt(enabled[0]!.price_amount)}
          {stockLabel(enabled[0]!)}
        </span>
      )}
      <Button size="sm" onClick={() => onPick(variantId)}>
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export default CreateOrderPage;
