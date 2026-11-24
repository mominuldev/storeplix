import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { Category, Product, ProductOption } from '@storeplix/types';
import { CATALOG_LIMITS } from '@storeplix/types';
import { Button, Checkbox, cn, DraftBar, DraftBarGhostButton, Input, Label, MoneyInput, SortableList, TagInput, Toggle, gripProps } from '@storeplix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Copy, GripVertical, Trash2, Upload } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm, type FieldPath } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { formatBdt, formatCount } from '../catalog/format';
import { useCategories, useInvalidate, useProduct } from '../catalog/queries';
import { keys, useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, StateCard } from '../catalog/states';
import { CatalogPanel as Panel, ProductStatusBadge, useIsMobile } from '../catalog/ui';
import { PRODUCT_IMAGE_ACCEPT, useProductImageUpload, type UploadedImage } from '../catalog/useImageUpload';
import { api } from '../lib/api';
import { ConflictDialog, LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { storeDomain } from '../stores/useTenantStore';
import { productFormSchema } from './schema';
import { OtherLocationsStock } from './OtherLocationsStock';
import { StockCell, VariantsCard } from './VariantsCard';
import { blankVariant, emptyProductForm, formToPayload, productToForm, serverPathToField, stockAdjustments, totalStock, type ProductFormValues, type VariantRow } from './variants';

const RichTextEditor = lazy(() => import('../online-store/richtext/RichTextEditor'));

// Figma Product editor 60:9381 (Main 60:9383), Variant row 61:13220. Built per contract §4: hidden — Write with AI,
// Add from URL, Collections, Where it's sold, Order form, Last 30 days, package & delivery charge, "After COD fee".
// "Preview on shop" is disabled until product pages ship (Phase 5).

export function ProductEditorPage() {
  const { productId } = useParams();
  const product = useProduct(productId);
  if (productId && product.isPending) return <LoadingState label="Loading product" />;
  if (productId && product.isError) {
    const notFound = isApiError(product.error) && product.error.status === 404;
    return (
      <StateCard>
        <ErrorBlock title={notFound ? 'Product not found' : 'We couldn’t load this product'} error={notFound ? undefined : product.error} onRetry={notFound ? undefined : () => void product.refetch()} />
        {notFound && (
          <p className="pb-8 text-center">
            <Link to="/products" className="font-semibold text-brand-600">
              Back to products
            </Link>
          </p>
        )}
      </StateCard>
    );
  }
  return <ProductEditor key={productId ?? 'new'} product={product.data ?? null} />;
}

const kgText = (grams: number | null) => (grams === null ? '' : String(grams / 1000));
function parseKg(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  if (!/^\d{1,4}(\.\d{1,3})?$/.test(t)) return Number.NaN;
  const [w, f = ''] = t.split('.');
  return Number(w) * 1000 + Number(f.padEnd(3, '0'));
}

function ProductEditor({ product }: { product: Product | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scope = useStoreScope();
  const isMobile = useIsMobile();
  const invalidate = useInvalidate();
  const categories = useCategories();
  const [current, setCurrent] = useState<Product | null>(product);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [weightText, setWeightText] = useState(() => kgText(product?.variants[0]?.weight_grams ?? null));
  const isNew = !current;

  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: product ? productToForm(product) : emptyProductForm(),
  });
  const { register, control, handleSubmit, watch, setValue, reset, setError, formState } = form;
  const values = watch();
  const { isDirty, isSubmitting, errors } = formState;
  const variants = values.variants;
  const isVariable = values.options.length > 0;
  const first = variants[0] ?? blankVariant();
  // PHASE-8-8C §10.3: stock fields edit the default location; "+ n at other locations" when stock is elsewhere.
  const elsewhere = new Map((product?.variants ?? []).filter((v) => v.inventory.other_locations_on_hand > 0).map((v) => [v.id, v.inventory]));
  const stockElsewhere = (row: VariantRow, label: string) => {
    const inv = row.id && product ? elsewhere.get(row.id) : undefined;
    return inv && product ? <OtherLocationsStock productId={product.id} variantId={row.id!} defaultLocationId={inv.location_id} count={inv.other_locations_on_hand} label={label} /> : null;
  };

  // Leave guard (same as the Phase 3 editors).
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const dirty = { shouldDirty: true } as const;
  const setVariants = (rows: VariantRow[]) => setValue('variants', rows, dirty);
  const patchVariant = (i: number, patch: Partial<VariantRow>) => setVariants(variants.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const patchAll = (patch: Partial<VariantRow>) => setVariants(variants.map((r) => ({ ...r, ...patch })));

  const addImage = useCallback(
    (img: UploadedImage) => {
      const imgs = form.getValues('images');
      if (imgs.some((i) => i.media_id === img.media_id)) return;
      form.setValue('images', [...imgs, { ...img, alt: '' }], { shouldDirty: true });
    },
    [form],
  );
  const photos = useProductImageUpload(addImage);

  const loadProduct = (p: Product) => {
    setCurrent(p);
    queryClient.setQueryData(keys.product(scope, p.id), p);
    reset(productToForm(p));
    setWeightText(kgText(p.variants[0]?.weight_grams ?? null));
  };

  const applyServerErrors = (e: unknown): boolean => {
    if (!isApiError(e) || e.status !== 422 || !e.details) return false;
    const unmapped: string[] = [];
    for (const [path, messages] of Object.entries(e.details)) {
      const field = serverPathToField(path);
      const root = field.split('.')[0];
      if (['name', 'slug', 'status', 'tags', 'category_ids', 'options', 'variants', 'images', 'seo_title', 'seo_description'].includes(root!)) {
        setError(field as FieldPath<ProductFormValues>, { type: 'server', message: messages[0] });
        if (root === 'images' || root === 'category_ids' || root === 'tags') unmapped.push(messages[0]!);
      } else unmapped.push(messages[0]!);
    }
    setFormError(unmapped.length ? unmapped.join(' ') : 'Check the highlighted fields.');
    return true;
  };

  const onSubmit = handleSubmit(async (v) => {
    setFormError(null);
    const payload = formToPayload(v, { canViewCosts: scope.canViewCosts });
    try {
      if (!current) {
        const created = await api.products.create(scope.storeId!, payload);
        await invalidate.afterProductSave(created.id);
        queryClient.setQueryData(keys.product(scope, created.id), created);
        reset(productToForm(created));
        toast('Product saved.');
        navigate(`/products/${created.id}`, { replace: true });
        return;
      }
      let saved = await api.products.update(scope.storeId!, current.id, { ...payload, revision: current.revision });
      const adjustments = stockAdjustments(v, saved);
      if (adjustments.length) {
        try {
          await api.inventory.adjust(scope.storeId!, { reason: 'correction', note: 'Edited in product editor', items: adjustments });
          saved = await api.products.get(scope.storeId!, saved.id);
        } catch (adjError) {
          saved = await api.products.get(scope.storeId!, saved.id);
          loadProduct(saved);
          await invalidate.afterProductSave(saved.id);
          const detail = isApiError(adjError) ? Object.values(adjError.details ?? {})[0]?.[0] : undefined;
          setFormError(`Product saved, but stock wasn’t changed: ${detail ?? errorMessage(adjError)}`);
          return;
        }
      }
      loadProduct(saved);
      await invalidate.afterProductSave(saved.id);
      toast('Product saved.');
    } catch (e) {
      if (isApiError(e) && e.code === 'revision_conflict') setConflict(true);
      else if (handlePlanLimit(e)) setFormError(null);
      else if (!applyServerErrors(e)) setFormError(errorMessage(e, 'Saving failed. Try again.'));
    }
  });

  const reload = async () => {
    if (!current) return;
    setReloading(true);
    try {
      loadProduct(await api.products.get(scope.storeId!, current.id));
      setConflict(false);
    } finally {
      setReloading(false);
    }
  };

  const discard = () => {
    if (!current) return navigate('/products');
    reset(productToForm(current));
    setWeightText(kgText(current.variants[0]?.weight_grams ?? null));
    setFormError(null);
  };

  const duplicate = async () => {
    if (!current) return;
    setDuplicating(true);
    try {
      const copy = await api.products.duplicate(scope.storeId!, current.id);
      await invalidate.afterProductSave();
      toast(`Copied as “${copy.name}” (draft).`);
      navigate(`/products/${copy.id}`);
    } catch (e) {
      if (!handlePlanLimit(e)) toast(errorMessage(e), 'error');
    } finally {
      setDuplicating(false);
    }
  };

  const changedCount = useMemo(() => Object.keys(formState.dirtyFields).length, [formState.dirtyFields]);
  const barTitle = isNew ? 'New product' : 'Unsaved changes';
  const barDescription = isNew ? 'Not saved yet' : `${changedCount} ${changedCount === 1 ? 'section' : 'sections'} changed. Buyers see the new version after you save.`;
  const bar =
    (isNew || isDirty) && !isMobile ? (
      <SaveCard title={barTitle} description={barDescription} onDiscard={discard} saving={isSubmitting} />
    ) : isNew || isDirty ? (
      <DraftBar
        title={barTitle}
        description={barDescription}
        className="fixed inset-x-3 bottom-[84px] z-30"
        actions={
          <>
            <DraftBarGhostButton onClick={discard} disabled={isSubmitting}>
              Discard
            </DraftBarGhostButton>
            <Button type="submit" form="product-form" loading={isSubmitting}>
              Save product
            </Button>
          </>
        }
      />
    ) : null;

  const nameError = errors.name?.message;
  const storeHost = scope.store ? storeDomain(scope.store) : 'your-shop.storeplix.com';
  const slugPreview = values.slug || current?.slug || 'product-link';
  const profit = first.price_amount !== null && first.cost_amount !== null && Number.isFinite(first.price_amount) && Number.isFinite(first.cost_amount) ? first.price_amount - first.cost_amount : null;
  const discount = first.compare_at_amount && first.price_amount && first.compare_at_amount > first.price_amount ? Math.round((1 - first.price_amount / first.compare_at_amount) * 100) : null;

  return (
    <form id="product-form" noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-5 pb-24 lg:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-caption text-text-secondary">
            <Link to="/products" className="hover:text-text-primary">
              Products
            </Link>
            <ChevronRight aria-hidden className="size-3" />
            <span>{isNew ? 'Add product' : 'Edit product'}</span>
          </nav>
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="truncate text-heading-24 text-text-primary">{isNew ? 'Add product' : current!.name}</h1>
            {current && <ProductStatusBadge status={current.status} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {current && (
            <Button variant="secondary" loading={duplicating} onClick={() => void duplicate()} leftIcon={<Copy aria-hidden className="size-4" />}>
              Duplicate
            </Button>
          )}
          <span title="Product pages arrive with checkout">
            <Button variant="secondary" disabled aria-describedby="preview-hint">
              Preview on shop
            </Button>
            <span id="preview-hint" className="sr-only">
              Product pages arrive with checkout
            </span>
          </span>
        </div>
      </div>

      {formError && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
          {formError}
        </p>
      )}

      <div className="grid gap-x-6 gap-y-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="order-2 flex min-w-0 flex-col gap-5 lg:order-1">
          <Panel>
            <Input label="Product name" placeholder="e.g. Jamdani Three-Piece — Handwoven Dhakai" maxLength={200} error={nameError} {...register('name')} />
            <div className="flex flex-col gap-1.5">
              <Label>Description</Label>
              <Suspense fallback={<div className="min-h-36 rounded-md border border-border-strong" />}>
                <Controller control={control} name="description" render={({ field }) => <RichTextEditor label="Description" value={field.value} onChange={field.onChange} />} />
              </Suspense>
            </div>
          </Panel>

          <PhotosPanel
            images={values.images}
            progress={photos.progress}
            error={photos.error ?? (errors.images as { message?: string } | undefined)?.message ?? null}
            onFiles={(files) => void photos.upload(files, CATALOG_LIMITS.images - values.images.length)}
            onChange={(imgs) => setValue('images', imgs, dirty)}
          />

          <Panel title="Pricing" description={scope.canViewCosts ? 'Cost is private — only you see it. We use it to show your profit.' : isVariable ? 'Applies to every variant. Fine-tune each one below.' : undefined}>
            <div className={cn('grid gap-4', scope.canViewCosts ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
              <MoneyInput
                label="Price"
                value={first.price_amount}
                error={errors.variants?.[0]?.price_amount?.message}
                onChange={(v) => (isVariable ? patchAll({ price_amount: v }) : patchVariant(0, { price_amount: v }))}
              />
              <MoneyInput
                label="Compare-at price"
                hint="Shown crossed out"
                value={first.compare_at_amount}
                error={errors.variants?.[0]?.compare_at_amount?.message}
                onChange={(v) => (isVariable ? patchAll({ compare_at_amount: v }) : patchVariant(0, { compare_at_amount: v }))}
              />
              {scope.canViewCosts && (
                <MoneyInput
                  label="Cost per item"
                  value={first.cost_amount}
                  error={errors.variants?.[0]?.cost_amount?.message}
                  onChange={(v) => (isVariable ? patchAll({ cost_amount: v }) : patchVariant(0, { cost_amount: v }))}
                />
              )}
            </div>
            {(scope.canViewCosts || discount !== null) && (
              <dl className="grid gap-y-3 rounded-lg bg-surface-subtle py-3.5 sm:grid-cols-3">
                {scope.canViewCosts && (
                  <>
                    <div className="flex flex-col gap-0.5 px-5">
                      <dt className="text-caption text-text-muted">Profit per item</dt>
                      <dd className={cn('text-heading', profit !== null && profit < 0 ? 'text-danger' : 'text-success')}>{profit === null ? '—' : formatBdt(profit)}</dd>
                      <dd className="text-caption text-text-secondary">after product cost</dd>
                    </div>
                    <div className="flex flex-col gap-0.5 px-5">
                      <dt className="text-caption text-text-muted">Margin</dt>
                      <dd className="text-heading text-text-primary">{profit !== null && first.price_amount ? `${Math.round((profit / first.price_amount) * 100)}%` : '—'}</dd>
                    </div>
                  </>
                )}
                <div className="flex flex-col gap-0.5 px-5">
                  <dt className="text-caption text-text-muted">Buyer sees</dt>
                  <dd className="text-heading text-brand-600">{discount !== null ? `${discount}% off` : 'Full price'}</dd>
                  {discount !== null && <dd className="text-caption text-text-secondary">{formatBdt(first.compare_at_amount! - first.price_amount!)} saved on shop</dd>}
                </div>
              </dl>
            )}
          </Panel>

          <Panel
            title="Inventory"
            description="Stock is tracked per variant. Changes are recorded in the stock ledger."
            actions={<Toggle label="Track stock" checked={first.track_inventory} onChange={(on) => patchAll({ track_inventory: on })} />}
          >
            {!isVariable ? (
              <div className="grid gap-4 sm:grid-cols-3">
                <Input label="SKU" maxLength={64} value={first.sku} error={errors.variants?.[0]?.sku?.message} onChange={(e) => patchVariant(0, { sku: e.target.value })} />
                <Input label="Barcode" maxLength={64} value={first.barcode} error={errors.variants?.[0]?.barcode?.message} onChange={(e) => patchVariant(0, { barcode: e.target.value })} />
                <div className="flex flex-col gap-1.5">
                  <Label>Stock</Label>
                  <StockCell className="md:w-full" title="Product" row={first} error={errors.variants?.[0]?.stock?.message} onChange={(stock) => patchVariant(0, { stock })} />
                  {stockElsewhere(first, 'Product')}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="text-body font-medium text-text-primary">Total stock</span>
                <span className="rounded-md bg-surface-subtle px-3 py-2.5 text-body text-text-secondary">
                  {formatCount(totalStock(variants))} · across {variants.length} variants
                </span>
              </div>
            )}
            <Checkbox label="Keep selling when out of stock (take pre-orders)" checked={first.allow_backorder} onChange={(e) => patchAll({ allow_backorder: e.target.checked })} />
          </Panel>

          <VariantsCard
            options={values.options}
            variants={variants}
            errors={errors}
            canViewCosts={scope.canViewCosts}
            images={values.images}
            onChange={(options: ProductOption[], rows: VariantRow[]) => {
              setValue('options', options, dirty);
              setVariants(rows.length ? rows : [blankVariant({ ...first, id: undefined, option_values: [], stock: 0, loaded_on_hand: null })]);
            }}
            onVariant={patchVariant}
            renderStockExtra={elsewhere.size > 0 ? stockElsewhere : undefined}
          />

          <Panel title="Shipping" description="Weight helps couriers (Steadfast, Pathao, RedX) price the parcel.">
            <Input
              label="Weight"
              inputMode="decimal"
              trailing={<span className="text-caption">kg</span>}
              containerClassName="sm:max-w-[240px]"
              value={weightText}
              error={Number.isNaN(parseKg(weightText) as number) ? 'Use kg, e.g. 0.6' : errors.variants?.[0]?.weight_grams?.message}
              onChange={(e) => {
                setWeightText(e.target.value);
                const g = parseKg(e.target.value);
                patchAll({ weight_grams: g === null || Number.isNaN(g) ? null : g });
              }}
            />
          </Panel>

          <Panel title="Search & link preview" description="How this product looks on Google and when shared on Facebook.">
            <div className="flex flex-col gap-1 rounded-lg bg-surface-subtle p-4">
              <span className="truncate text-caption text-text-secondary">
                {storeHost} › products › {slugPreview}
              </span>
              <span className="truncate text-body-lg text-info">
                {values.seo_title || values.name || 'Product name'}
                {scope.store ? ` | ${scope.store.name}` : ''}
              </span>
              <span className="line-clamp-2 text-caption text-text-secondary">{values.seo_description || 'Add a short description so buyers know what they’ll get.'}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="URL handle" placeholder="jamdani-three-piece" maxLength={220} error={errors.slug?.message} hint={isNew ? 'Made from the name if left empty' : undefined} {...register('slug')} />
              <Input label="Page title" maxLength={70} error={errors.seo_title?.message} hint={`${values.seo_title.length}/70`} {...register('seo_title')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="seo-description">Description</Label>
              <textarea
                id="seo-description"
                rows={3}
                maxLength={160}
                className="rounded-md border border-border-default px-3 py-2 text-body outline-none focus:border-brand-600"
                {...register('seo_description')}
              />
              <span className={cn('text-caption', errors.seo_description ? 'text-danger' : 'text-text-muted')}>{errors.seo_description?.message ?? `${values.seo_description.length}/160`}</span>
            </div>
          </Panel>
        </div>

        <aside className="order-1 flex min-w-0 flex-col gap-5 lg:sticky lg:top-4 lg:order-2">
          {!isMobile && bar}
          <Panel title="Status" compact>
            <div role="radiogroup" aria-label="Status" className="flex flex-col gap-4">
              {(
                [
                  ['active', 'Active', 'Visible on your shop once it’s live'],
                  ['draft', 'Draft', 'Only you can see it'],
                  ['archived', 'Archived', 'Hidden, kept for history'],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className="flex cursor-pointer items-start gap-2.5">
                  <input type="radio" value={value} className="size-5 shrink-0 accent-brand-600" {...register('status')} />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-body font-medium text-text-primary">{label}</span>
                    <span className="text-caption text-text-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </Panel>
          <Panel title="Organize" compact>
            <CategoryPicker categories={categories.data ?? []} value={values.category_ids} onChange={(ids) => setValue('category_ids', ids, dirty)} error={(errors.category_ids as { message?: string } | undefined)?.message} />
            <TagInput
              label="Tags"
              value={values.tags}
              onChange={(t) => setValue('tags', t, dirty)}
              max={CATALOG_LIMITS.tags}
              hint="Tags help buyers find it in search. Not shown on the product page."
              error={(errors.tags as { message?: string } | undefined)?.message}
            />
          </Panel>
        </aside>
      </div>
      {isMobile && bar}
      <ConflictDialog open={conflict} loading={reloading} onReload={() => void reload()} />
    </form>
  );
}

/**
 * Save bar (sticky) 62:12890: text-primary card, radius 16, padding 20, gap 12 — coral dot + Body/14 Semibold title,
 * Caption muted description, then Discard (secondary) and Save product (primary) as two equal 40px buttons.
 */
function SaveCard({ title, description, onDiscard, saving }: { title: string; description: string; onDiscard: () => void; saving: boolean }) {
  return (
    <div role="region" aria-label="Unsaved changes" className="flex flex-col gap-3 rounded-card bg-text-primary p-5 text-text-inverse shadow-elevation-1">
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent-500" />
        <p className="min-w-0 flex-1 text-body font-semibold">{title}</p>
      </div>
      <p className="text-caption text-text-muted">{description}</p>
      <div className="flex gap-2">
        <Button variant="secondary" className="min-w-0 flex-1" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button type="submit" form="product-form" className="min-w-0 flex-1" loading={saving}>
          Save product
        </Button>
      </div>
    </div>
  );
}

/** Organize · Category (Figma select look) as a multi-select: a select-styled button with a checkbox list. */
function CategoryPicker({ categories, value, onChange, error }: { categories: Category[]; value: string[]; onChange: (ids: string[]) => void; error?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const names = categories.filter((c) => value.includes(c.id)).map((c) => c.name);
  return (
    <div ref={ref} className="relative flex flex-col gap-1.5">
      <Label>Category</Label>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Categories: ${names.join(', ') || 'none'}`}
        onClick={() => setOpen((o) => !o)}
        className={cn('flex h-11 items-center gap-2 rounded-control border bg-surface-card px-3.5 text-left text-body outline-none focus-visible:shadow-focus', error ? 'border-danger' : 'border-border-default')}
      >
        <span className={cn('min-w-0 flex-1 truncate', names.length ? 'text-text-primary' : 'text-text-muted')}>{names.join(', ') || 'Choose categories'}</span>
        <ChevronDown aria-hidden className="size-[18px] text-text-muted" />
      </button>
      {open && (
        <div role="listbox" aria-multiselectable aria-label="Categories" className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border-default bg-surface-card p-1.5 shadow-elevation-1">
          {categories.length === 0 ? (
            <p className="px-2 py-2 text-caption text-text-muted">
              No categories yet.{' '}
              <Link to="/products/categories" className="text-brand-600">
                Create one
              </Link>
            </p>
          ) : (
            categories.map((c) => {
              const on = value.includes(c.id);
              return (
                <label key={c.id} role="option" aria-selected={on} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-subtle" style={{ paddingLeft: 8 + (c.depth - 1) * 16 }}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && value.length >= CATALOG_LIMITS.categories_per_product}
                    onChange={() => onChange(on ? value.filter((x) => x !== c.id) : [...value, c.id])}
                    className="size-4 accent-brand-600"
                  />
                  <span className="text-body text-text-primary">{c.name}</span>
                </label>
              );
            })
          )}
        </div>
      )}
      {error && <p className="text-caption text-danger">{error}</p>}
    </div>
  );
}

/** Photos card: ordered grid (first = cover), drag to reorder, upload with progress, "N of 10". */
function PhotosPanel({
  images,
  progress,
  error,
  onFiles,
  onChange,
}: {
  images: { media_id: string; url: string; alt: string }[];
  progress: number | null;
  error: string | null;
  onFiles: (files: File[]) => void;
  onChange: (imgs: { media_id: string; url: string; alt: string }[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const full = images.length >= CATALOG_LIMITS.images;
  const items = images.map((i) => ({ ...i, id: i.media_id }));
  return (
    <Panel title="Photos" description="First photo is the cover on your shop and Facebook. Drag to reorder.">
      {/* Media 61:13065: 232px cover (2×2) + 110px tiles, 12px gaps; the drop tile (232×110) sits in the grid. */}
      <div className="grid grid-cols-3 gap-3 sm:auto-rows-[110px] sm:grid-cols-[repeat(auto-fill,110px)] [&>ul>li:first-child]:col-span-2 [&>ul>li:first-child]:row-span-2">
        <SortableList
          label="Photos"
          items={items}
          className="contents"
          onMove={(from, to) => {
            const next = images.slice();
            const [m] = next.splice(from, 1);
            next.splice(to, 0, m!);
            onChange(next);
          }}
          renderItem={(img, { handle, index }) => (
            <div className="group relative aspect-square size-full overflow-hidden rounded-lg bg-surface-subtle">
              <img src={img.url} alt={img.alt || `Photo ${index + 1}`} className="size-full object-cover" />
              {index === 0 && <span className="absolute bottom-2 left-2 rounded-full bg-text-primary px-2 py-0.5 text-caption font-medium text-text-inverse">Cover</span>}
              <button type="button" aria-label={`Move photo ${index + 1}`} className="absolute top-1.5 left-1.5 rounded-md bg-surface-card/90 p-1 text-text-secondary" {...gripProps(handle)}>
                <GripVertical aria-hidden className="size-4" />
              </button>
              <button type="button" aria-label={`Remove photo ${index + 1}`} onClick={() => onChange(images.filter((x) => x.media_id !== img.media_id))} className="absolute top-1.5 right-1.5 rounded-md bg-surface-card/90 p-1 text-text-secondary hover:text-danger">
                <Trash2 aria-hidden className="size-4" />
              </button>
            </div>
          )}
        />
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFiles(Array.from(e.dataTransfer.files));
          }}
          className={cn(
            'col-span-full flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-strong bg-surface-subtle px-3 py-5 text-center',
            images.length > 0 && 'sm:col-span-2 sm:py-0',
            full && 'opacity-60',
          )}
        >
          <Upload aria-hidden className="size-5 text-text-secondary" />
          <button type="button" disabled={full || progress !== null} onClick={() => inputRef.current?.click()} className="text-caption font-medium text-text-primary hover:text-brand-600 disabled:cursor-not-allowed">
            {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Drop photos or click to upload'}
          </button>
          <span className="text-caption text-text-muted">
            JPG/PNG/WebP · up to 10 MB · {images.length} of {CATALOG_LIMITS.images}
          </span>
          {progress !== null && (
            <div role="progressbar" aria-label="Photo upload" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} className="mt-1 h-1 w-40 overflow-hidden rounded-full bg-border-default">
              <div className="h-full bg-brand-600" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={PRODUCT_IMAGE_ACCEPT}
            className="sr-only"
            aria-label="Upload photos"
            onChange={(e) => {
              onFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </Panel>
  );
}

export default ProductEditorPage;
