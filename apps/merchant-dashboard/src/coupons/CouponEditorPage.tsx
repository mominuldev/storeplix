import { isApiError } from '@storeplix/api-client';
import type { Coupon, CouponStatus } from '@storeplix/types';
import { Button, buttonVariants, Checkbox, ChipSelect, cn, CouponStatusBadge, Dialog, Input, MoneyInput, PercentInput, Toggle } from '@storeplix/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatBdt } from '../catalog/format';
import { useCategories } from '../catalog/queries';
import { keys, useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, StateCard } from '../catalog/states';
import { SearchBox, Thumb, useDebounced } from '../catalog/ui';
import { useCommerceInvalidate, useCoupon } from '../commerce/queries';
import { api } from '../lib/api';
import { FormAlert } from '../onboarding/AuthShell';
import { ConflictDialog, LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { storeDomain } from '../stores/useTenantStore';
import { fromCoupon, fromDhakaLocal, toInput, validateCoupon, type FormState, type ProductRef } from './form';
import { couponValue } from './labels';
import { generateCode, previewCheckout, type CouponRule, type PreviewLine } from './math';

// Figma Create coupon 68:19255. Contract §9 / P5-11: code + Generate, share link /discount/{CODE} (Q38) with copy,
// type cards, Applies to (all / categories / products), Conditions (minimum, total uses, uses per customer, first
// order only), Active dates in store time (Asia/Dhaka) with "No end date", Live preview + "At checkout" example
// computed client-side (P5-12). Save draft / Publish. Not built (§11): Good delivery record, Combine, Estimated impact.

export function CouponEditorPage() {
  const { couponId } = useParams();
  const isNew = !couponId || couponId === 'new';
  const query = useCoupon(isNew ? undefined : couponId);
  if (!isNew && query.isPending) return <LoadingState label="Loading coupon" />;
  if (!isNew && query.isError)
    return (
      <StateCard>
        <ErrorBlock title={isApiError(query.error) && query.error.status === 404 ? 'Coupon not found' : 'We couldn’t load this coupon'} error={query.error} onRetry={() => void query.refetch()} />
        <p className="pb-8 text-center">
          <Link to="/marketing/coupons" className="font-semibold text-brand-600">
            Back to coupons
          </Link>
        </p>
      </StateCard>
    );
  const coupon = isNew ? null : (query.data ?? null);
  return <CouponForm key={coupon ? `${coupon.id}:${coupon.revision}` : 'new'} coupon={coupon} />;
}

const SAMPLE: PreviewLine[] = [
  { name: 'Cotton Panjabi', detail: 'White · 40 · × 1', amount: 185_000 },
  { name: 'Kids Kurti', detail: 'Yellow · 6–7 y · × 1', amount: 117_000 },
];
const SAMPLE_DELIVERY = 7_000;

function CouponForm({ coupon }: { coupon: Coupon | null }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const editable = scope.canManageMarketing;
  const [f, setF] = useState<FormState>(() => fromCoupon(coupon));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const categories = useCategories();
  const patch = (p: Partial<FormState>) => setF((x) => ({ ...x, ...p }));
  const locked = !!coupon && coupon.stats.used_count > 0; // code and type immutable once used

  const save = useMutation({
    mutationFn: (status: CouponStatus) => {
      const input = toInput(f, status);
      if (!coupon) return api.coupons.create(scope.storeId!, input);
      const { code, type, ...rest } = input;
      return api.coupons.update(scope.storeId!, coupon.id, { ...rest, ...(locked ? {} : { code, type }), revision: coupon.revision });
    },
    onSuccess: async (saved, status) => {
      toast(status === 'active' ? `${saved.code} is live.` : status === 'disabled' ? `${saved.code} turned off.` : `${saved.code} saved as draft.`);
      await invalidate.coupons(saved.id);
      if (!coupon) navigate(`/marketing/coupons/${saved.id}`, { replace: true });
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'revision_conflict') return setConflict(true);
      if (isApiError(e) && e.status === 422 && e.details) {
        const next: Record<string, string> = {};
        for (const [k, m] of Object.entries(e.details)) next[k.replace(/\.\d+$/, '')] = m[0] ?? '';
        setErrors(next);
        return setFormError('Some fields need attention.');
      }
      setFormError(errorMessage(e, 'We couldn’t save this coupon.'));
    },
  });
  const remove = useMutation({
    mutationFn: () => api.coupons.delete(scope.storeId!, coupon!.id),
    onSuccess: async () => {
      toast(`${coupon!.code} deleted.`);
      await invalidate.coupons();
      navigate('/marketing/coupons', { replace: true });
    },
    onError: (e) => {
      setDeleting(false);
      toast(isApiError(e) && e.code === 'coupon_in_use' ? 'This code has been used, so it can’t be deleted. Turn it off instead.' : errorMessage(e), 'error');
    },
  });

  const submit = (status: CouponStatus) => {
    const e = validateCoupon(f);
    setErrors(e);
    if (Object.keys(e).length) return setFormError('Some fields need attention.');
    setFormError(null);
    save.mutate(status);
  };

  const shareUrl = scope.store ? `https://${storeDomain(scope.store)}/discount/${f.code || 'CODE'}` : `/discount/${f.code || 'CODE'}`;
  const rule: CouponRule = {
    type: f.type,
    percent_bps: f.percent_bps !== null && Number.isFinite(f.percent_bps) ? f.percent_bps : 0,
    amount: f.amount !== null && Number.isFinite(f.amount) ? f.amount : 0,
    max_discount_amount: f.max_discount_amount !== null && Number.isFinite(f.max_discount_amount) ? f.max_discount_amount : null,
    min_subtotal_amount: f.min_subtotal_amount !== null && Number.isFinite(f.min_subtotal_amount) ? f.min_subtotal_amount : null,
  };
  const sample: PreviewLine[] =
    f.applies_to === 'products' && f.products.length && f.type !== 'free_shipping'
      ? f.products.slice(0, 2).map((p) => ({ name: p.name, detail: '× 1', amount: p.price_min_amount }))
      : SAMPLE;
  const preview = previewCheckout(rule, sample, SAMPLE_DELIVERY);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <nav aria-label="Breadcrumb" className="flex flex-wrap gap-2 text-caption font-medium text-text-muted">
            <Link to="/marketing/coupons" className="hover:text-text-primary">
              Marketing
            </Link>
            <span aria-hidden>/</span>
            <Link to="/marketing/coupons" className="hover:text-text-primary">
              Coupons
            </Link>
            <span aria-hidden>/</span>
            <span>{coupon ? coupon.code : 'New'}</span>
          </nav>
          <div className="flex items-center gap-2">
            <h1 className="text-heading-24 text-text-primary">{coupon ? `Edit ${coupon.code}` : 'Create coupon'}</h1>
            {coupon && <CouponStatusBadge status={coupon.display_status} />}
          </div>
          <p className="text-body text-text-secondary">Customers see the discount instantly at checkout — no codes to check by hand.</p>
        </div>
        {editable && (
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            {!coupon && (
              <Link to="/marketing/coupons" className={buttonVariants({ variant: 'ghost' })}>
                Cancel
              </Link>
            )}
            {coupon && coupon.stats.used_count === 0 && (
              <Button variant="ghost" onClick={() => setDeleting(true)}>
                Delete
              </Button>
            )}
            {coupon && coupon.status === 'active' ? (
              <Button variant="secondary" loading={save.isPending && save.variables === 'disabled'} onClick={() => submit('disabled')}>
                Turn off
              </Button>
            ) : (
              <Button variant="secondary" loading={save.isPending && save.variables === 'draft'} onClick={() => submit(coupon?.status === 'disabled' ? 'disabled' : 'draft')}>
                {coupon?.status === 'disabled' ? 'Save' : 'Save draft'}
              </Button>
            )}
            <Button loading={save.isPending && save.variables === 'active'} onClick={() => submit('active')}>
              {coupon?.status === 'active' ? 'Save changes' : 'Publish coupon'}
            </Button>
          </div>
        )}
      </div>
      {formError && <FormAlert>{formError}</FormAlert>}
      {!editable && <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">Only owners and managers can change coupons.</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-4">
          <Section title="Coupon code" description="Customers type it at checkout or tap your share link.">
            <div className="flex items-end gap-2">
              <Input
                id="coupon-code"
                label="Code"
                value={f.code}
                maxLength={32}
                disabled={locked}
                hint={locked ? 'Used codes can’t be renamed. Create a new code instead.' : undefined}
                error={errors.code}
                containerClassName="flex-1"
                onChange={(e) => patch({ code: e.target.value.toUpperCase().replace(/\s/g, '') })}
              />
              <Button variant="secondary" disabled={locked} onClick={() => patch({ code: generateCode() })}>
                Generate
              </Button>
            </div>
            <div className="flex items-center gap-2 rounded-md bg-surface-subtle px-3 py-2 text-caption text-text-secondary">
              <ExternalLink aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate" data-testid="share-link">
                {shareUrl.replace(/^https:\/\//, '')} — opens your shop with the coupon applied
              </span>
              <button
                type="button"
                aria-label="Copy share link"
                disabled={!f.code}
                onClick={() =>
                  void (navigator.clipboard?.writeText(shareUrl) ?? Promise.reject(new Error('no clipboard'))).then(
                    () => toast('Share link copied.'),
                    () => toast(shareUrl),
                  )
                }
                className="rounded-sm p-1 hover:text-text-primary disabled:opacity-40"
              >
                <Copy aria-hidden className="size-3.5" />
              </button>
            </div>
          </Section>

          <Section title="Discount type">
            <div role="radiogroup" aria-label="Discount type" className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ['percentage', 'Percentage', 'Off the order total'],
                  ['fixed', 'Fixed amount', 'Flat taka off'],
                  ['free_shipping', 'Free delivery', 'Every zone'],
                ] as const
              ).map(([value, title, hint]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={f.type === value}
                  disabled={locked}
                  onClick={() => patch({ type: value, ...(value === 'free_shipping' ? { applies_to: 'all' as const } : {}) })}
                  className={cn(
                    'flex items-center gap-3 rounded-lg text-left outline-none focus-visible:shadow-focus disabled:opacity-60',
                    f.type === value ? 'border-2 border-brand-600 bg-brand-50 px-[15px] py-[13px]' : 'border border-border-default bg-surface-card px-4 py-3.5 hover:bg-surface-subtle',
                  )}
                >
                  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full', f.type === value ? 'border-[6px] border-brand-600 bg-surface-card' : 'border-[1.5px] border-border-strong bg-surface-card')} />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-body font-semibold text-text-primary">{title}</span>
                    <span className="text-caption text-text-secondary">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
            {f.type === 'percentage' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <PercentInput id="coupon-percent" label="Discount (%)" value={f.percent_bps} onChange={(v) => patch({ percent_bps: v })} error={errors.percent_bps} />
                <MoneyInput id="coupon-cap" label="Maximum discount (optional)" value={f.max_discount_amount} onChange={(v) => patch({ max_discount_amount: v })} error={errors.max_discount_amount} />
              </div>
            )}
            {f.type === 'fixed' && <MoneyInput id="coupon-amount" label="Amount off" value={f.amount} onChange={(v) => patch({ amount: v })} error={errors.amount} containerClassName="sm:max-w-xs" />}
          </Section>

          {f.type !== 'free_shipping' && (
            <Section title="Applies to">
              <div role="radiogroup" aria-label="Applies to" className="flex flex-wrap gap-2">
                {(
                  [
                    ['all', 'All products'],
                    ['categories', 'Specific categories'],
                    ['products', 'Specific products'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={f.applies_to === value}
                    onClick={() => patch({ applies_to: value })}
                    className={cn('h-9 rounded-full border px-4 text-body', f.applies_to === value ? 'border-brand-600 bg-brand-50 font-medium text-brand-700' : 'border-border-default text-text-secondary')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {f.applies_to === 'categories' && (
                <div className="flex flex-col gap-1.5">
                  <ChipSelect
                    aria-label="Categories"
                    options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
                    value={f.category_ids}
                    onChange={(v) => patch({ category_ids: v })}
                    size="sm"
                  />
                  {categories.data?.length === 0 && <p className="text-caption text-text-muted">You have no categories yet.</p>}
                  <p className="text-caption text-text-muted">Includes products in their sub-categories.</p>
                  {errors.category_ids && <p className="text-caption text-danger">{errors.category_ids}</p>}
                </div>
              )}
              {f.applies_to === 'products' && <ProductPicker value={f.products} onChange={(products) => patch({ products })} error={errors.product_ids} />}
            </Section>
          )}

          <Section title="Conditions & limits" description="Protect your margin and your delivery cost.">
            <div className="grid gap-4 sm:grid-cols-3">
              <MoneyInput id="coupon-min" label="Minimum order" value={f.min_subtotal_amount} onChange={(v) => patch({ min_subtotal_amount: v })} error={errors.min_subtotal_amount} />
              <Input id="coupon-limit" label="Total uses" inputMode="numeric" placeholder="No limit" value={f.usage_limit} error={errors.usage_limit} onChange={(e) => patch({ usage_limit: e.target.value.trim() })} />
              <Input
                id="coupon-per-customer"
                label="Uses per customer"
                inputMode="numeric"
                placeholder="No limit"
                value={f.usage_per_customer}
                error={errors.usage_per_customer}
                onChange={(e) => patch({ usage_per_customer: e.target.value.trim() })}
              />
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border-default pt-4">
              <span className="flex flex-col">
                <span className="text-body font-medium text-text-primary">First order only</span>
                <span className="text-caption text-text-muted">Only for phone numbers that never ordered from you before</span>
              </span>
              <Toggle label="First order only" checked={f.first_order_only} disabled={!editable} onChange={(v) => patch({ first_order_only: v })} />
            </div>
          </Section>

          <Section title="Active dates" description="Bangladesh time (GMT+6)">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input id="coupon-starts" type="datetime-local" label="Starts" value={f.starts_at} error={errors.starts_at} onChange={(e) => patch({ starts_at: e.target.value })} />
              <Input id="coupon-ends" type="datetime-local" label="Ends" value={f.ends_at} disabled={f.no_end} error={errors.ends_at} onChange={(e) => patch({ ends_at: e.target.value })} />
            </div>
            <Checkbox label="No end date" checked={f.no_end} onChange={(e) => patch({ no_end: e.target.checked })} />
          </Section>
        </fieldset>

        <aside aria-label="Live preview" className="flex flex-col gap-4 lg:sticky lg:top-20">
          <span className="text-caption font-medium text-text-muted uppercase">Live preview</span>
          <div className="flex flex-col gap-3.5 rounded-card bg-brand-600 p-6 text-text-inverse shadow-elevation-1">
            <span className="text-caption font-medium">{scope.store?.name}</span>
            <span className="text-display" data-testid="preview-headline">
              {f.type === 'percentage' ? `${(rule.percent_bps ?? 0) / 100}% OFF` : f.type === 'fixed' ? `${formatBdt(rule.amount ?? 0)} OFF` : 'FREE DELIVERY'}
            </span>
            <span className="text-body">
              {[f.type === 'percentage' && rule.max_discount_amount ? `Up to ${formatBdt(rule.max_discount_amount)} off` : null, rule.min_subtotal_amount ? `on orders over ${formatBdt(rule.min_subtotal_amount)}` : null]
                .filter(Boolean)
                .join(' ') || couponValue({ type: f.type, percent_bps: rule.percent_bps, amount: rule.amount, max_discount_amount: rule.max_discount_amount })}
            </span>
            <div className="flex items-center justify-between border-t border-dashed border-text-inverse/50 pt-3.5">
              <span className="rounded-md border border-dashed border-text-inverse px-3 py-1.5 text-body-lg font-medium">{f.code || 'CODE'}</span>
              <span className="text-caption">{f.no_end || !f.ends_at ? 'No end date' : `Valid till ${new Date(fromDhakaLocal(f.ends_at) ?? '').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}</span>
            </div>
          </div>
          <section aria-label="At checkout" className="flex flex-col gap-3.5 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-body-lg font-medium text-text-primary">At checkout</h2>
              <span className="text-caption text-text-muted">How a customer sees it</span>
            </div>
            <ul className="flex flex-col gap-2">
              {sample.map((l) => (
                <li key={l.name} className="flex items-center justify-between gap-3 text-body">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-text-primary">{l.name}</span>
                    <span className="text-caption text-text-muted">{l.detail}</span>
                  </span>
                  <span className="font-semibold text-text-primary">{formatBdt(l.amount)}</span>
                </li>
              ))}
            </ul>
            <dl className="flex flex-col gap-1.5 border-t border-border-default pt-3 text-body">
              <PreviewRow label="Subtotal" value={formatBdt(preview.subtotal)} />
              {preview.discount > 0 && <PreviewRow label={`${f.code || 'CODE'}${rule.max_discount_amount && preview.discount === rule.max_discount_amount ? ' (capped)' : ''}`} value={`− ${formatBdt(preview.discount)}`} tone="success" />}
              <PreviewRow label="Delivery · Inside Dhaka" value={preview.shippingDiscount ? 'Free' : formatBdt(preview.shipping)} tone={preview.shippingDiscount ? 'success' : undefined} />
              <PreviewRow label="Total to pay on delivery" value={formatBdt(preview.total)} strong />
            </dl>
            {preview.applied ? (
              <p className="flex items-center gap-1.5 rounded-md bg-success-bg px-3 py-2 text-caption text-success">
                <Check aria-hidden className="size-3.5" /> Coupon applied automatically
              </p>
            ) : (
              <p className="flex items-center gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-caption text-warning">
                <X aria-hidden className="size-3.5" /> Spend {formatBdt(rule.min_subtotal_amount ?? 0)} or more to use this code.
              </p>
            )}
          </section>
          {coupon && (
            <section aria-label="Results" className="grid grid-cols-2 gap-2 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1">
              <Stat label="Used" value={`${coupon.stats.used_count}${coupon.usage_limit ? ` / ${coupon.usage_limit}` : ''}`} />
              <Stat label="Orders" value={String(coupon.stats.orders_count)} />
              <Stat label="Revenue" value={formatBdt(coupon.stats.revenue_amount)} />
              <Stat label="Discount given" value={formatBdt(coupon.stats.discount_amount)} />
            </section>
          )}
        </aside>
      </div>

      <Dialog
        open={deleting}
        tone="danger"
        title={`Delete ${coupon?.code}?`}
        description="The code stops working right away."
        confirmLabel="Delete coupon"
        loading={remove.isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
      />
      <ConflictDialog
        open={conflict}
        onReload={() => {
          setConflict(false);
          void invalidate.coupons(coupon?.id);
        }}
      />
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
        {description && <p className="text-caption text-text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function PreviewRow({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'success' }) {
  return (
    <div className={cn('flex items-center justify-between gap-3', strong ? 'pt-1 font-semibold text-text-primary' : 'text-text-secondary', tone === 'success' && 'text-success')}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded-md bg-surface-subtle px-3 py-2">
      <span className="text-caption text-text-muted">{label}</span>
      <span className="text-body font-semibold text-text-primary">{value}</span>
    </div>
  );
}

function ProductPicker({ value, onChange, error }: { value: ProductRef[]; onChange: (v: ProductRef[]) => void; error?: string }) {
  const scope = useStoreScope();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const results = useQuery({
    queryKey: keys.products(scope, { q: debounced, per_page: 8, picker: 'coupon' }),
    queryFn: () => api.products.list(scope.storeId!, { q: debounced, per_page: 8 }),
    enabled: !!scope.storeId && debounced.trim().length > 0,
  });
  const ids = new Set(value.map((p) => p.id));
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <SearchBox value={q} onChange={setQ} placeholder="Search products" label="Search products for this coupon" />
        {debounced.trim() && (
          <ul aria-label="Product results" className="absolute inset-x-0 top-11 z-10 max-h-64 overflow-y-auto rounded-md border border-border-default bg-surface-card shadow-elevation-1">
            {results.data?.data
              .filter((p) => !ids.has(p.id))
              .map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange([...value, { id: p.id, name: p.name, image: p.image, price_min_amount: p.price_min_amount }].slice(0, 100));
                      setQ('');
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-subtle"
                  >
                    <Thumb src={p.image?.url} size={32} />
                    <span className="flex-1 truncate text-body">{p.name}</span>
                    <span className="text-caption text-text-muted">{formatBdt(p.price_min_amount)}</span>
                  </button>
                </li>
              ))}
            {results.data?.data.length === 0 && <li className="px-3 py-3 text-caption text-text-muted">No products match.</li>}
          </ul>
        )}
      </div>
      <ul aria-label="Selected products" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {value.map((p) => (
          <li key={p.id} className="relative flex flex-col gap-1.5 rounded-lg border border-border-default p-2">
            <Thumb src={p.image?.url} size={96} className="w-full" />
            <span className="truncate text-caption font-medium text-text-primary">{p.name}</span>
            <span className="text-caption text-text-muted">{formatBdt(p.price_min_amount)}</span>
            <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((x) => x.id !== p.id))} className="absolute top-1 right-1 rounded-full bg-surface-card p-1 shadow-elevation-1">
              <X aria-hidden className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="text-caption text-danger">{error}</p>}
    </div>
  );
}

export default CouponEditorPage;
