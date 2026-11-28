'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition, type ReactNode } from 'react';
import type { ProductOption } from '@storeplix/types';
import { addToCart, buyNow } from '@/app/actions/commerce';
import { formatMoney } from '@/lib/format';
import { findVariant, initialSelection, optionState, type PdpVariant } from '@/lib/pdp';
import { emitTrack } from '@/lib/tracking-events';
import { Icon } from '../components/icon';
import { notifyCartChanged } from './cart-badge';
import { QtyStepper } from './ui';

export interface PdpImage {
  url: string;
  alt: string;
  unoptimized: boolean;
}

interface Props {
  slug: string;
  name: string;
  currency: string;
  options: ProductOption[];
  variants: PdpVariant[];
  images: PdpImage[];
  /** False on a draft store's public view (never rendered) or when checkout is off: buttons still add to bag. */
  heading: ReactNode;
  details: ReactNode;
}

type Avail = Record<string, { available: boolean; low_stock: number | null }>;

/**
 * Figma PDP desktop 1:11034 / mobile 1:11250: gallery (thumbnails, variant image switches the main
 * photo), price with compare-at and "Save ৳ N", option chips, "Only N left" (from the no-store
 * availability route, never in the HTML), qty stepper, Add to cart and Buy now — cash on delivery.
 */
export function ProductView({ slug, name, currency, options, variants, images, heading, details }: Props) {
  const [selection, setSelection] = useState<string[]>(() => initialSelection(variants, options));
  const [touched, setTouched] = useState(false);
  const [avail, setAvail] = useState<Avail | null>(null);
  const [qty, setQty] = useState(1);
  const [imageIndex, setImageIndex] = useState(() => variants[0]?.image_index ?? 0);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    fetch(`/api/availability/${encodeURIComponent(slug)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { data?: { variants?: Array<{ id: string; available: boolean; low_stock: number | null }> } } | null) => {
        if (!alive || !b?.data?.variants) return;
        const map: Avail = {};
        for (const v of b.data.variants) map[v.id] = { available: v.available === true, low_stock: typeof v.low_stock === 'number' ? v.low_stock : null };
        setAvail(map);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [slug]);

  // Before the shopper picks anything, move off a sold-out default to the first available variant.
  useEffect(() => {
    if (!avail || touched) return;
    const current = findVariant(variants, selection);
    if (current && avail[current.id]?.available !== false) return;
    const firstAvailable = variants.find((v) => avail[v.id]?.available);
    if (firstAvailable) {
      setSelection(options.length ? firstAvailable.option_values : []);
      if (firstAvailable.image_index !== null) setImageIndex(firstAvailable.image_index);
    }
  }, [avail, touched, variants, selection, options.length]);

  const variant = useMemo(() => findVariant(variants, selection), [variants, selection]);
  const state = variant && avail ? avail[variant.id] : undefined;
  const soldOut = Boolean(variant && avail && state?.available === false);
  const lowStock = state?.available ? state.low_stock : null;
  const maxQty = Math.max(1, Math.min(99, lowStock ?? 99));
  const save = variant?.compare_at_amount ? variant.compare_at_amount - variant.price_amount : 0;

  const choose = (optionIndex: number, value: string) => {
    setTouched(true);
    setMessage(null);
    const next = [...selection];
    next[optionIndex] = value;
    setSelection(next);
    const v = findVariant(variants, next);
    if (v?.image_index !== null && v?.image_index !== undefined) setImageIndex(v.image_index);
    setQty(1);
  };

  const submit = (mode: 'add' | 'buy') =>
    start(async () => {
      if (!variant) return;
      setMessage(null);
      const r = mode === 'buy' ? await buyNow({ variantId: variant.id, quantity: qty }) : await addToCart({ variantId: variant.id, quantity: qty });
      // 8.9d §6.2: add_to_cart after a successful add (no-op unless the shop's tracking runtime is mounted).
      if (r.ok) emitTrack({ name: 'add_to_cart', variant_id: variant.id, quantity: qty, value_amount: variant.price_amount * qty, currency });
      if (r.ok && r.redirect) {
        notifyCartChanged(r.linesCount);
        router.push(r.redirect);
        return;
      }
      if (r.ok) {
        notifyCartChanged(r.linesCount);
        setMessage({ tone: 'ok', text: [`Added to your bag.`, ...r.notices].join(' ') });
      } else setMessage({ tone: 'error', text: r.message });
    });

  const main = images[imageIndex] ?? images[0];

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:gap-16">
      {/* Gallery */}
      <div className="flex min-w-0 flex-col-reverse gap-3 lg:w-[700px] lg:shrink-0 lg:flex-row lg:gap-5">
        {images.length > 1 ? (
          <ul className="flex gap-2.5 overflow-x-auto pb-1 lg:max-h-[700px] lg:w-20 lg:shrink-0 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto [scrollbar-width:none]" aria-label="Product photos">
            {images.map((img, i) => (
              <li key={img.url} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setImageIndex(i)}
                  aria-label={`Show photo ${i + 1}`}
                  aria-current={i === imageIndex}
                  className={`relative block size-16 overflow-hidden rounded-sf-xs border bg-sunken lg:h-24 lg:w-20 ${i === imageIndex ? 'border-2 border-ink' : 'border-line-subtle'}`}
                >
                  <Image src={img.url} alt="" fill sizes="80px" unoptimized={img.unoptimized} className="object-cover" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="relative min-w-0 flex-1 pr-2.5 pb-2.5">
          <div className="relative aspect-[59/71] overflow-hidden rounded-sf-xs border border-line bg-surface p-[13px] shadow-[10px_10px_0_0_var(--color-sun)]">
            <div className="relative size-full overflow-hidden rounded-[2px] bg-sunken">
              {main ? (
                <Image src={main.url} alt={main.alt || name} fill priority sizes="(min-width: 1024px) 600px, 100vw" unoptimized={main.unoptimized} className="object-cover" />
              ) : (
                <span aria-hidden className="absolute inset-0 flex items-center justify-center text-ink-muted opacity-60">
                  <Icon name="bag" size={40} />
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Buy box */}
      <div className="flex min-w-0 flex-1 flex-col gap-5 lg:gap-6">
        {heading}

        {variant ? (
          <p className="flex flex-wrap items-baseline gap-3" data-sp-price>
            <span className="type-price-l text-ink lg:type-display-m">{formatMoney(variant.price_amount, currency)}</span>
            {variant.compare_at_amount ? (
              <s className="type-body-m text-ink-muted lg:type-body-l">
                <span className="sr-only">Was </span>
                {formatMoney(variant.compare_at_amount, currency)}
              </s>
            ) : null}
            {save > 0 ? <span className="type-label-s rounded-full bg-accent-soft px-3 py-1 text-sale">Save {formatMoney(save, currency)}</span> : null}
          </p>
        ) : null}

        <hr className="border-line-subtle" />

        {options.map((option, oi) => (
          <fieldset key={option.name} className="flex flex-col gap-3">
            <legend className="type-label-m mb-3 text-ink">
              {option.name}: <span className="type-body-m ml-0.5 text-ink-secondary">{selection[oi] ?? ''}</span>
            </legend>
            <div className="grid grid-cols-3 gap-2 lg:flex lg:flex-wrap">
              {option.values.map((value) => {
                const st = optionState(variants, selection, oi, value, avail);
                const selected = selection[oi] === value;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={st === 'missing'}
                    aria-pressed={selected}
                    onClick={() => choose(oi, value)}
                    className={`type-label-m rounded-sf-md lg:min-w-[78px] border px-[18px] py-3 transition ${
                      selected ? 'border-ink bg-inverse text-paper' : 'border-line bg-surface text-ink hover:border-ink'
                    } ${st === 'sold_out' && !selected ? 'text-ink-muted line-through' : ''} disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    {value}
                    {st === 'sold_out' ? <span className="sr-only"> (sold out)</span> : null}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}

        {!variant ? <p className="type-body-s text-sale">This combination isn&apos;t available. Choose another option.</p> : null}
        {lowStock !== null ? (
          <p className="type-label-s -mt-3 flex items-center gap-2 text-sale" data-sp-low-stock>
            <Icon name="lightning" />
            Only {lowStock} left{options.length && selection.length ? ` in ${selection.join(' / ')}` : ''}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <QtyStepper value={qty} max={maxQty} disabled={soldOut || !variant} label="Quantity" onChange={(n) => setQty(Math.min(maxQty, Math.max(1, n)))} />
            <button
              type="button"
              onClick={() => submit('add')}
              disabled={!variant || soldOut || pending}
              className="type-label-m flex h-[52px] min-w-0 flex-1 items-center justify-center gap-2 rounded-control bg-brand px-7 text-on-brand transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {soldOut ? 'Sold out' : pending ? 'Adding…' : 'Add to cart'}
              {soldOut ? null : <Icon name="bag-inverse" />}
            </button>
          </div>
          {soldOut ? null : (
            <button
              type="button"
              onClick={() => submit('buy')}
              disabled={!variant || pending}
              className="type-label-m flex h-[51px] w-full items-center justify-center rounded-control bg-orange px-7 text-ink transition hover:brightness-105 disabled:opacity-60"
            >
              Buy now — cash on delivery
            </button>
          )}
          <p aria-live="polite" className={`type-body-s empty:hidden ${message?.tone === 'error' ? 'text-sale' : 'text-brand'}`}>
            {message?.text}
            {message?.tone === 'ok' ? (
              <>
                {' '}
                <Link href="/cart" className="font-semibold underline">
                  View bag
                </Link>
              </>
            ) : null}
          </p>
        </div>

        {details}
      </div>
    </div>
  );
}
