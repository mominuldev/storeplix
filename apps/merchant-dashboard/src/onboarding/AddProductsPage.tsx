import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { CreateProductInput, ProductOption, RichTextDoc, RichTextInline } from '@storeplix/types';
import { Badge, Button, ChipSelect, cn, Input, Label, MoneyInput, ProgressBar } from '@storeplix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, FileSpreadsheet, Plug, Plus, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { useAuth } from '../auth/AuthProvider';
import { formatBdt } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { PRODUCT_IMAGE_ACCEPT, useProductImageUpload, type UploadedImage } from '../catalog/useImageUpload';
import { api } from '../lib/api';
import { handlePlanLimit, PlanLimitDialog } from '../plan/Banners';
import { combinations } from '../products/variants';
import { storeDomain } from '../stores/useTenantStore';
import { FormAlert } from './AuthShell';
import { PhonePreview, type PreviewProduct } from './PhonePreview';
import { StepRail } from './StepRail';

// Figma Merchant Onboarding · 05 Add first products 50:312. No mobile frame exists (P4-27): mobile stacks the desktop
// column and hides the phone preview below `lg`. "Write description in Bangla (AI)" and "Import from Facebook" are
// not built. Products are created `active` in the current store; with sizes chosen, "Stock" is per size (Q26).

const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const MAX_PHOTOS = 8;
const TARGET = 3;

/** Plain text → RichTextDoc: blank line = new paragraph, single newline = hardBreak (contract §5.2 rule). */
export function plainTextToDoc(text: string): RichTextDoc | null {
  const paras = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) return null;
  return {
    type: 'doc',
    content: paras.map((p) => ({
      type: 'paragraph' as const,
      content: p.split('\n').flatMap((line, i): RichTextInline[] => (i === 0 ? [{ type: 'text', text: line }] : [{ type: 'hardBreak' }, { type: 'text', text: line }])).filter((n) => n.type !== 'text' || n.text !== ''),
    })),
  };
}

const schema = z
  .object({
    name: z.string().trim().min(1, 'Give the product a name.').max(200, 'Keep the name to 200 characters.'),
    description: z.string().max(5000, 'Keep the description shorter.'),
    price: z.number({ error: 'Enter a price.' }).nullable().refine((n) => Boolean(n !== null), 'Enter a price.').refine((n) => n === null || Number.isFinite(n), 'Enter an amount like 3450.'),
    compare: z.number().nullable().refine((n) => n === null || Number.isFinite(n), 'Enter an amount like 3950.'),
    stock: z.string().refine((s) => !s.trim() || /^\d{1,6}$/.test(s.trim()), 'Use a whole number.'),
    sizes: z.array(z.string()),
    colours: z.array(z.string()),
  })
  .refine((v) => v.compare === null || v.price === null || v.compare > v.price, { path: ['compare'], message: 'Compare-at price must be higher than the price.' });

type QuickAdd = z.infer<typeof schema>;
const blank: QuickAdd = { name: '', description: '', price: null, compare: null, stock: '', sizes: [], colours: [] };

/** Quick-add form → POST /products body (variable when sizes/colours are chosen; stock per variant). */
export function quickAddToProduct(v: QuickAdd, images: UploadedImage[]): CreateProductInput {
  const options: ProductOption[] = [
    ...(v.sizes.length ? [{ name: 'Size', values: v.sizes }] : []),
    ...(v.colours.length ? [{ name: 'Colour', values: v.colours }] : []),
  ];
  const stock = v.stock.trim() ? Number(v.stock.trim()) : 0;
  return {
    name: v.name.trim(),
    status: 'active',
    description: plainTextToDoc(v.description),
    options,
    images: images.map((i) => ({ media_id: i.media_id })),
    variants: combinations(options).map((values) => ({ option_values: values, price_amount: v.price!, compare_at_amount: v.compare, initial_on_hand: stock })),
  };
}

export function AddProductsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const scope = useStoreScope();
  const store = scope.store!;
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [added, setAdded] = useState<(PreviewProduct & { variants: number; stock: number; sizes: string[] })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [colourMode, setColourMode] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const addImage = useCallback((img: UploadedImage) => setImages((list) => (list.some((i) => i.media_id === img.media_id) ? list : [...list, img])), []);
  const photos = useProductImageUpload(addImage);
  const form = useForm<QuickAdd>({ resolver: zodResolver(schema), defaultValues: blank });
  const { register, control, handleSubmit, watch, reset, formState } = form;
  const sizes = watch('sizes');
  const colours = watch('colours');
  const name = watch('name');
  const isFilled = !!(name.trim() || watch('price') !== null || images.length);

  const save = async (v: QuickAdd): Promise<boolean> => {
    setError(null);
    try {
      const body = quickAddToProduct(v, images);
      const p = await api.products.create(scope.storeId!, body);
      setAdded((list) => [...list, { name: p.name, price: formatBdt(p.price_min_amount, { symbol: false }), img: images[0]?.url ?? null, variants: body.variants.length, stock: Number(v.stock || 0), sizes: v.sizes }]);
      reset(blank);
      setImages([]);
      setColourMode(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: keys.products(scope) }), queryClient.invalidateQueries({ queryKey: keys.dashboard(scope) })]);
      return true;
    } catch (e) {
      if (!handlePlanLimit(e)) setError(isApiError(e) && e.fieldErrors ? Object.values(e.fieldErrors).flat()[0] ?? e.message : errorMessage(e, 'Saving failed. Try again.'));
      return false;
    }
  };

  const addAnother = handleSubmit(async (v) => {
    await save(v);
  });
  const saveAndContinue = async () => {
    if (!isFilled) return navigate('/onboarding/delivery');
    await handleSubmit(async (v) => {
      if (await save(v)) navigate('/onboarding/delivery');
    })();
  };

  const last = added[added.length - 1];
  const counter = Math.min(added.length + 1, Math.max(TARGET, added.length + 1));

  return (
    <div className="flex min-h-dvh bg-surface-canvas">
      <StepRail shopName={store.name} current={5} phoneVerified={!!user?.phone_verified_at} />
      <div className="flex min-w-0 flex-1 flex-col lg:items-center">
        <div className="hidden w-full items-center justify-between px-10 py-5 lg:flex">
          <span className="text-caption font-medium text-text-secondary">Step 5 of 7</span>
          <span className="flex items-center gap-4">
            {added.length > 0 && (
              <span className="flex items-center gap-1.5 text-caption text-text-muted">
                <Check aria-hidden className="size-4 text-success" /> Saved
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
              Save & exit
            </Button>
          </span>
        </div>
        <header className="flex flex-col gap-3 px-4 pt-2 pb-3 lg:hidden">
          <div className="flex items-center justify-between">
            <button type="button" aria-label="Back" onClick={() => navigate('/onboarding/theme')} className="flex size-9 items-center justify-center rounded-full border border-border-default bg-surface-card">
              <ChevronLeft aria-hidden className="size-[18px]" />
            </button>
            <span className="text-body font-semibold text-text-primary">Step 5 of 7</span>
            <button type="button" onClick={() => navigate('/')} className="text-body font-medium text-brand-600">
              Save & exit
            </button>
          </div>
          <ProgressBar value={5 / 7} label="Setup progress" className="h-1 rounded-[2px]" />
        </header>

        <div className="flex w-full max-w-[620px] flex-1 flex-col gap-5 px-5 pt-3 pb-40 lg:gap-7 lg:px-0 lg:pt-2 lg:pb-12">
          <div className="flex flex-col gap-1.5 lg:gap-2">
            <h1 className="text-heading-24 text-text-primary lg:text-heading-32">Add your first products</h1>
            <p className="text-body text-text-secondary lg:hidden">Start with a best seller — add more later.</p>
            <p className="hidden text-body-lg text-text-secondary lg:block">Start with 1–3 best sellers. You can add the rest from your dashboard anytime.</p>
            <p lang="bn" className="font-bangla text-body-lg leading-[26px] text-text-muted">
              <span className="lg:hidden">প্রথম পণ্যটি যোগ করুন</span>
              <span className="hidden lg:inline">প্রথমে আপনার জনপ্রিয় ১–৩টি পণ্য যোগ করুন</span>
            </p>
          </div>

          <div className="flex flex-col gap-5">
          <div role="radiogroup" aria-label="How to add products" className="-mx-5 flex gap-2.5 overflow-x-auto px-5 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-3 sm:overflow-visible sm:px-0">
            <ChoiceCard selected icon={<Plus />} title="Add manually" hint="Photo, name, price and sizes — about a minute." />
            <ChoiceCard disabled icon={<Plug />} title="Import from Facebook" hint="Pick posts from your page — we pull photos & prices." badge="Coming soon" />
            <ChoiceCard
              icon={<FileSpreadsheet />}
              title="Upload CSV / Excel"
              hint={scope.canBulkData ? 'Bulk add from a spreadsheet. Template included.' : 'Ask a manager to import a spreadsheet.'}
              disabled={!scope.canBulkData}
              onSelect={() => navigate('/products/import?from=onboarding')}
            />
          </div>

          {error && <FormAlert>{error}</FormAlert>}

          <form
            noValidate
            aria-label="Quick add"
            onSubmit={(e) => {
              e.preventDefault();
              void addAnother();
            }}
            className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 lg:gap-5 lg:p-6"
          >
            <div className="hidden items-center justify-between lg:flex">
              <h2 className="text-body-lg font-medium text-text-primary">Quick add</h2>
              <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-caption font-medium text-text-secondary">
                Product {counter} of {Math.max(TARGET, counter)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {images.map((img, i) => (
                <div key={img.media_id} className="relative size-[88px] overflow-hidden rounded-lg sm:size-28">
                  <img src={img.url} alt={`Photo ${i + 1}`} className="size-full object-cover" />
                  {i === 0 && <span className="absolute bottom-1.5 left-1.5 rounded-full bg-text-primary px-2 py-0.5 text-caption text-text-inverse">Cover</span>}
                  <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => setImages((l) => l.filter((x) => x.media_id !== img.media_id))} className="absolute top-1 right-1 rounded-full bg-surface-card/90 p-0.5">
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
              ))}
              {images.length < MAX_PHOTOS && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={photos.progress !== null}
                  className="flex size-[88px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong bg-surface-subtle text-caption font-medium text-brand-600 sm:size-28"
                >
                  <Plus aria-hidden className="size-5" />
                  {photos.progress !== null ? `${Math.round(photos.progress * 100)}%` : 'Add photo'}
                </button>
              )}
              <p className="min-w-24 flex-1 text-caption text-text-muted">
                {photos.error ?? (
                  <>
                    <span className="sm:hidden">Up to {MAX_PHOTOS} photos</span>
                    <span className="hidden sm:inline">Add up to {MAX_PHOTOS} photos. Tip: daylight photos on a plain background sell 2× better.</span>
                  </>
                )}
              </p>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={PRODUCT_IMAGE_ACCEPT}
                className="sr-only"
                aria-label="Product photos"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  void photos.upload(files, MAX_PHOTOS - images.length);
                }}
              />
            </div>

            <Input label="Product name" placeholder="e.g. Jamdani Three-Piece — Red & Gold" maxLength={200} error={formState.errors.name?.message} {...register('name')} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qa-desc">Description</Label>
              <textarea
                id="qa-desc"
                rows={3}
                placeholder="Fabric, fit, what’s included. Bangla or English."
                className="rounded-md border border-border-default px-3 py-2 text-body outline-none focus:border-brand-600"
                {...register('description')}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Controller control={control} name="price" render={({ field }) => <MoneyInput label="Price" value={field.value} onChange={field.onChange} error={formState.errors.price?.message} />} />
              <Controller
                control={control}
                name="compare"
                render={({ field }) => <MoneyInput label="Compare-at (optional)" value={field.value} onChange={field.onChange} error={formState.errors.compare?.message} />}
              />
              <Input
                label={sizes.length || colours.length ? 'Stock per size' : 'Stock'}
                inputMode="numeric"
                placeholder="0"
                trailing={<span className="text-caption">pcs</span>}
                error={formState.errors.stock?.message}
                {...register('stock')}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-body font-medium text-text-primary">Sizes</span>
                {!colourMode && (
                  <button type="button" onClick={() => setColourMode(true)} className="text-body font-medium text-brand-600">
                    + Add colours
                  </button>
                )}
              </div>
              <Controller
                control={control}
                name="sizes"
                render={({ field }) => <ChipSelect aria-label="Sizes" options={SIZES.map((value) => ({ value }))} value={field.value} onChange={field.onChange} allowCustom customLabel="Custom" max={20} />}
              />
            </div>
            {colourMode && (
              <div className="flex flex-col gap-2">
                <span className="text-body font-medium text-text-primary">Colours</span>
                <Controller
                  control={control}
                  name="colours"
                  render={({ field }) => <ChipSelect aria-label="Colours" options={[]} value={field.value} onChange={field.onChange} allowCustom customLabel="Add colour" max={20} />}
                />
              </div>
            )}
            {sizes.length * Math.max(1, colours.length) > 100 && <p className="text-caption text-danger">That’s more than 100 variants. Pick fewer sizes or colours.</p>}
            <div className="flex items-center justify-between gap-3">
              <Button type="submit" size="sm" variant="secondary" loading={formState.isSubmitting} leftIcon={<Plus aria-hidden className="size-3.5" />}>
                Add another product
              </Button>
              {last && (
                <span role="status" className="flex items-center gap-1.5 text-caption text-text-muted">
                  <Check aria-hidden className="size-4 text-success" /> Saved {added.length === 1 ? '1 product' : `${added.length} products`}
                </span>
              )}
            </div>
          </form>
          </div>

          <div className="fixed inset-x-0 bottom-0 z-10 flex items-center justify-between gap-3 border-t border-border-default bg-surface-card px-5 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:static lg:border-0 lg:bg-transparent lg:p-0">
            <button type="button" className="hidden items-center gap-1 text-body font-medium text-text-secondary hover:text-text-primary lg:inline-flex" onClick={() => navigate('/onboarding/theme')}>
              <ChevronLeft aria-hidden className="size-4" /> Back
            </button>
            {/* M4 54:935: full-width Save & continue with Skip for now underneath; desktop: Skip · Save in a row. */}
            <span className="flex flex-1 flex-col-reverse items-stretch gap-3 lg:flex-row lg:items-center lg:justify-end lg:gap-2">
              <Button variant="ghost" className="min-h-5 py-0 text-text-secondary lg:min-h-10 lg:py-2" onClick={() => navigate('/')}>
                Skip for now
              </Button>
              <Button loading={formState.isSubmitting} onClick={() => void saveAndContinue()}>
                Save & continue
              </Button>
            </span>
          </div>
        </div>
      </div>
      <PhonePreview
        name={store.name}
        domain={storeDomain(store)}
        caption={added.length ? `${added.length} product${added.length === 1 ? '' : 's'} added` : 'Sample products'}
        products={added.map(({ name: n, price, img }) => ({ name: n, price, img }))}
        footer={
          last && (
            <div role="status" className="flex w-full items-center gap-3 rounded-card border border-border-default bg-surface-card p-3 shadow-elevation-1">
              {last.img ? <img src={last.img} alt="" className="size-11 rounded-md object-cover" /> : <span className="size-11 rounded-md bg-surface-subtle" />}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-semibold text-text-primary">{last.name} is live</span>
                <span className="truncate text-caption text-text-muted">
                  ৳ {last.price}
                  {last.sizes.length ? ` · ${last.sizes.join(', ')}` : ''} · {last.stock * last.variants} in stock
                </span>
              </span>
              <Check aria-hidden className="size-5 text-success" />
            </div>
          )
        }
      />
      <PlanLimitDialog />
    </div>
  );
}

function ChoiceCard({ icon, title, hint, selected, disabled, badge, onSelect }: { icon: React.ReactNode; title: string; hint: string; selected?: boolean; disabled?: boolean; badge?: string; onSelect?: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={!!selected}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-[150px] shrink-0 flex-col gap-3 rounded-[14px] p-4 text-left sm:w-auto outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
        selected ? 'border-2 border-brand-600 bg-brand-50' : 'border border-border-default bg-surface-card',
        disabled && 'opacity-60',
      )}
    >
      <span className="flex items-center justify-between">
        <span className={cn('flex size-10 items-center justify-center rounded-control [&_svg]:size-[22px]', selected ? 'bg-surface-card text-brand-600' : 'bg-brand-50 text-brand-600')}>{icon}</span>
        {badge ? <Badge>{badge}</Badge> : selected ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-brand-600">
            <span className="size-2 rounded-full bg-surface-card" />
          </span>
        ) : (
          <span className="size-5 rounded-full border-[1.5px] border-border-strong bg-surface-card" />
        )}
      </span>
      <span className="text-body font-semibold text-text-primary">{title}</span>
      <span className="text-caption text-text-secondary">{hint}</span>
    </button>
  );
}

export default AddProductsPage;
