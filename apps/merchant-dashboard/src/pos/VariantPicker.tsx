import type { PosCatalogItem, PosCatalogVariant } from '@storeplix/types';
import { Badge, Button, cn, formatBdt, formatCount, Modal } from '@storeplix/ui';
import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { Thumb } from '../catalog/ui';
import { defaultSelection, findVariant, maxQuantity, optionGroups, variantFor, variantInStock } from './pos';

// PHASE-8-8D §11.3 Variant picker 22:1905: "Choose options" + "Scan a variant barcode to skip this step"; product header
// (image, name, "SKU {sku} · …", price + struck compare-at, "{options} · n in this shop"); option chips with "n left" /
// "Out" (disabled) on the last group; quantity stepper; "Add to sale · ৳ x". Colour swatch dots are not drawn (no colour
// data on variants).

export function VariantPicker({
  item,
  inCart,
  onClose,
  onAdd,
}: {
  item: PosCatalogItem;
  inCart: (variantId: string) => number;
  onClose: () => void;
  onAdd: (variant: PosCatalogVariant, quantity: number) => void;
}) {
  const groups = optionGroups(item);
  const [selected, setSelected] = useState<Record<string, string>>(() => defaultSelection(item));
  const [quantity, setQuantity] = useState(1);
  const variant = findVariant(item, selected);
  const max = variant ? Math.max(0, maxQuantity(variant.available) - inCart(variant.id)) : 0;
  const qty = Math.min(quantity, Math.max(1, max));
  const canAdd = !!variant && variantInStock(variant) && max > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Choose options"
      description="Scan a variant barcode to skip this step"
      size="lg"
      className="max-md:h-dvh max-md:max-h-dvh max-md:w-full max-md:max-w-none max-md:rounded-none"
    >
      <div className="flex flex-col gap-5" data-testid="pos-variant-picker">
        <div className="flex gap-4">
          <Thumb src={item.image_url} size={136} className="rounded-lg max-sm:!size-24" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-heading text-text-primary">{item.name}</h3>
            {variant?.sku && <p className="text-caption text-text-secondary">SKU {variant.sku}</p>}
            <p className="flex items-baseline gap-2">
              <span className="text-heading-24 text-brand-600">{formatBdt(variant?.price_amount ?? null)}</span>
              {variant?.compare_at_amount && variant.compare_at_amount > variant.price_amount && (
                <s className="text-body text-text-muted">{formatBdt(variant.compare_at_amount)}</s>
              )}
            </p>
            {variant && (
              <Badge size="sm" tone={variantInStock(variant) ? 'success' : 'danger'} className="self-start">
                {[variant.title, variant.available === null ? 'In stock' : `${formatCount(variant.available)} in this shop`].filter(Boolean).join(' · ')}
              </Badge>
            )}
          </div>
        </div>

        {groups.map((g, gi) => {
          const last = gi === groups.length - 1;
          return (
            <fieldset key={g.name} className="flex flex-col gap-2.5">
              <legend className="mb-2.5 text-body font-medium text-text-primary">{g.name}</legend>
              <div className={cn('flex flex-wrap gap-2.5', last && 'grid grid-cols-3 sm:grid-cols-5')}>
                {g.values.map((value) => {
                  const v = variantFor(item, selected, g.name, value);
                  const out = !v || !variantInStock(v);
                  const active = selected[g.name] === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={active}
                      disabled={last && out}
                      onClick={() => {
                        setSelected({ ...selected, [g.name]: value });
                        setQuantity(1);
                      }}
                      className={cn(
                        'flex flex-col items-center justify-center rounded-lg border px-4 text-body outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-40',
                        last ? 'min-h-14 py-2' : 'min-h-9 rounded-full py-1.5',
                        active ? 'border-2 border-brand-600 bg-brand-50 text-brand-700' : 'border-border-default bg-surface-card text-text-primary hover:bg-surface-subtle',
                      )}
                    >
                      <span>{value}</span>
                      {last && v && (
                        <span className={cn('text-caption', out ? 'text-text-muted' : v.available !== null && v.available <= 3 ? 'text-warning' : 'text-text-muted')}>
                          {out ? 'Out' : v.available === null ? 'In stock' : `${formatCount(v.available)} left`}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          );
        })}

        <div className="flex gap-3">
          <div className="flex items-center rounded-lg border border-border-default">
            <button
              type="button"
              aria-label="Decrease quantity"
              className="flex size-12 items-center justify-center text-text-primary disabled:opacity-40"
              disabled={qty <= 1}
              onClick={() => setQuantity(qty - 1)}
            >
              <Minus aria-hidden className="size-4" />
            </button>
            <span className="w-10 text-center text-body-lg font-medium" aria-live="polite" data-testid="pos-picker-qty">
              {qty}
            </span>
            <button
              type="button"
              aria-label="Increase quantity"
              className="flex size-12 items-center justify-center text-text-primary disabled:opacity-40"
              disabled={qty >= max}
              onClick={() => setQuantity(qty + 1)}
            >
              <Plus aria-hidden className="size-4" />
            </button>
          </div>
          <Button className="min-h-12 flex-1 text-body-lg" disabled={!canAdd} onClick={() => variant && onAdd(variant, qty)} data-testid="pos-picker-add">
            {canAdd ? `Add to sale · ${formatBdt((variant?.price_amount ?? 0) * qty)}` : 'Out of stock here'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
