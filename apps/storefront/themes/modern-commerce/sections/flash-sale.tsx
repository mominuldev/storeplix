import Link from 'next/link';
import type { SectionProps } from '../../types';
import type { FlashSaleSettings } from '../schema';
import { formatMoney } from '@/lib/format';
import { getFlashDeals, type FlashDeal } from '@/lib/products';
import { Countdown } from '../components/countdown';
import { Icon } from '../components/icon';
import { MaybeLink } from '../components/product-card';
import { ProductImage } from '../components/product-image';

/**
 * Figma "Flash Deal Card" (1:9642): discount pill, sale price, stock meter, Add to cart. Real deals
 * have no stock data, so the meter is hidden. No link / cart until Phase 5.
 */
function DealCard({ deal }: { deal: FlashDeal }) {
  const meter = deal.stock_left !== null && deal.claimed_percent !== null ? { left: deal.stock_left, claimed: deal.claimed_percent } : null;
  return (
    <article className="relative flex w-[200px] shrink-0 snap-start flex-col gap-3 rounded-sf-lg bg-surface p-3 text-[#0e1a33] lg:w-auto lg:min-w-0 lg:flex-1">
      <div className="relative h-[170px] overflow-hidden rounded-sf-xs bg-sunken lg:h-[240px]">
        <MaybeLink href={deal.href} label={deal.name} className="absolute inset-0">
          <ProductImage image={deal.image} sizes="(min-width: 1024px) 25vw, 200px" />
        </MaybeLink>
        {deal.discount_label ? (
          <span className="type-label-m pointer-events-none absolute top-2.5 left-2.5 flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-on-accent">
            <Icon name="lightning-sm" />
            {deal.discount_label}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 px-1">
        <h3 className="type-label-m">
          {deal.href ? (
            <Link href={deal.href} className="hover:underline">
              {deal.name}
            </Link>
          ) : (
            deal.name
          )}
        </h3>
        <p className="flex items-baseline gap-2">
          <span className="type-price-m text-sale">{formatMoney(deal.price_amount, deal.currency)}</span>
          {deal.compare_at_amount !== null ? (
            <span className="type-body-s leading-[1.3] text-[#66728c]">
              <span className="sr-only">Was </span>
              {formatMoney(deal.compare_at_amount, deal.currency)}
            </span>
          ) : null}
        </p>
      </div>
      {meter ? (
        <div className="flex flex-col gap-1.5" data-sp-stock-meter>
          <span className="h-2 overflow-hidden rounded-full bg-sunken" aria-hidden>
            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, meter.claimed))}%` }} />
          </span>
          <span className="type-label-s flex justify-between gap-2">
            <span className={meter.claimed >= 75 ? 'text-sale' : ''}>{meter.left} left</span>
            <span className="text-[#66728c]">{meter.claimed}% claimed</span>
          </span>
        </div>
      ) : null}
      <button
        type="button"
        disabled
        className="type-label-m mt-auto flex cursor-not-allowed items-center justify-center gap-2 rounded-control bg-brand px-5 py-3 text-on-brand opacity-60"
      >
        Add to cart
        <Icon name="bag-inverse" />
      </button>
    </article>
  );
}

/**
 * Figma "Flash sale" - desktop 1:10195, mobile 1:10373. Brand panel with countdown and deal
 * cards: `on_sale` feed products, or placeholder deals while the store has no products. A store with
 * products but no sale items hides the section (live) or shows a note (preview). The countdown hides
 * when `endsAt` is empty or past.
 */
export async function FlashSaleSection({ id, settings: s, ctx }: SectionProps<FlashSaleSettings>) {
  const { deals } = await getFlashDeals(ctx.host, s.limit, { preview: ctx.preview });
  if (deals.length === 0 && !ctx.preview) return null;
  const remaining = s.endsAt ? Date.parse(s.endsAt) - Date.now() : 0;

  return (
    <div className="px-4 lg:px-20">
      <div className="flex flex-col gap-6 overflow-hidden rounded-sf-xl bg-brand p-5 text-on-brand lg:gap-8 lg:p-10">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
          <div className="flex flex-col items-start gap-3.5">
            {s.eyebrow ? (
              <p className="type-eyebrow flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-on-accent">
                <Icon name="lightning" />
                {s.eyebrow}
              </p>
            ) : null}
            <h2 id={`${id}-title`} className="type-display-m max-md:text-[32px]">
              {s.title}
            </h2>
            {s.subtitle ? <p className="type-body-m hidden opacity-85 md:block">{s.subtitle}</p> : null}
          </div>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-8">
            {s.endsAt && remaining > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="type-label-s flex items-center gap-1.5">
                  <Icon name="clock" />
                  Ends in
                </p>
                <Countdown endsAt={s.endsAt} initialRemainingMs={remaining} />
              </div>
            ) : null}
            {s.linkLabel && s.linkHref ? (
              <Link
                href={s.linkHref}
                className="type-label-m hidden items-center justify-center gap-2 rounded-control bg-surface px-7 py-4 whitespace-nowrap text-[#0e1a33] hover:bg-sunken lg:inline-flex"
              >
                {s.linkLabel}
                <Icon name="arrow-right" />
              </Link>
            ) : null}
          </div>
        </div>
        {deals.length > 0 ? (
          <div className="-mx-5 flex snap-x gap-3 overflow-x-auto px-5 lg:mx-0 lg:gap-5 lg:overflow-visible lg:px-0 [scrollbar-width:none]">
            {deals.map((d) => (
              <DealCard key={d.id} deal={d} />
            ))}
          </div>
        ) : (
          <p className="type-body-m rounded-sf-lg bg-surface/10 p-4" data-sp-preview-note>
            No sale items yet — add a compare-at price to show products here
          </p>
        )}
        {s.linkLabel && s.linkHref ? (
          <Link
            href={s.linkHref}
            className="type-label-m flex items-center justify-center gap-2 rounded-control bg-surface px-7 py-4 text-[#0e1a33] lg:hidden"
          >
            {s.linkLabel}
            <Icon name="arrow-right" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
