import Link from 'next/link';
import type { SectionProps } from '../../types';
import type { FlashSaleSettings } from '../schema';
import { formatPrice } from '@/lib/format';
import { getFlashDeals, type FlashDeal } from '@/lib/products';
import { Countdown } from '../components/countdown';
import { Icon } from '../components/icon';
import { ThemeImage } from '../components/theme-image';

/** Figma "Flash Deal Card" (1:9642): discount pill, sale price, stock meter, Add to cart. */
function DealCard({ deal, currency }: { deal: FlashDeal; currency: string }) {
  const href = `/products/${encodeURIComponent(deal.slug)}`;
  const low = deal.claimed_percent >= 75;
  return (
    <article className="flex w-[200px] shrink-0 snap-start flex-col gap-3 rounded-sf-lg bg-surface p-3 text-[#0e1a33] lg:w-auto lg:min-w-0 lg:flex-1">
      <div className="relative h-[170px] overflow-hidden rounded-sf-xs bg-sunken lg:h-[240px]">
        <Link href={href} aria-label={deal.name} className="absolute inset-0">
          <ThemeImage src={deal.image_url} alt="" sizes="(min-width: 1024px) 25vw, 200px" />
        </Link>
        <span className="type-label-m pointer-events-none absolute top-2.5 left-2.5 flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-on-accent">
          <Icon name="lightning-sm" />
          {deal.discount_label}
        </span>
      </div>
      <div className="flex flex-col gap-2 px-1">
        <h3 className="type-label-m">
          <Link href={href} className="hover:underline">
            {deal.name}
          </Link>
        </h3>
        <p className="flex items-baseline gap-2">
          <span className="type-price-m text-sale">{formatPrice(deal.price, currency)}</span>
          {deal.compare_at_price !== null ? (
            <span className="type-body-s leading-[1.3] text-[#66728c]">
              <span className="sr-only">Was </span>
              {formatPrice(deal.compare_at_price, currency)}
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="h-2 overflow-hidden rounded-full bg-sunken" aria-hidden>
          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, deal.claimed_percent))}%` }} />
        </span>
        <span className="type-label-s flex justify-between gap-2">
          <span className={low ? 'text-sale' : ''}>{deal.stock_left} left</span>
          <span className="text-[#66728c]">{deal.claimed_percent}% claimed</span>
        </span>
      </div>
      <Link
        href={href}
        className="type-label-m flex items-center justify-center gap-2 rounded-control bg-brand px-5 py-3 text-on-brand hover:brightness-110"
      >
        Add to cart
        <Icon name="bag-inverse" />
      </Link>
    </article>
  );
}

/**
 * Figma "Flash sale" - desktop 1:10195, mobile 1:10373. Brand panel with countdown and deal
 * cards (PLACEHOLDER deals until Phase 5). The countdown hides when `endsAt` is empty or past.
 */
export async function FlashSaleSection({ id, settings: s, ctx }: SectionProps<FlashSaleSettings>) {
  const deals = await getFlashDeals(ctx.host, s.limit);
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
        <div className="-mx-5 flex snap-x gap-3 overflow-x-auto px-5 lg:mx-0 lg:gap-5 lg:overflow-visible lg:px-0 [scrollbar-width:none]">
          {deals.map((d) => (
            <DealCard key={d.id} deal={d} currency={ctx.store.currency} />
          ))}
        </div>
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
