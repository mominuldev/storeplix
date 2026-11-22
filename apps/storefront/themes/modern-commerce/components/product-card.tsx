import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ProductCardView } from '@/lib/products';
import { formatMoney } from '@/lib/format';
import { QuickAddButton } from '../commerce/quick-add';
import { Icon } from './icon';
import { ProductImage } from './product-image';

const BADGE_TONES: Record<NonNullable<ProductCardView['badge']>['tone'], string> = {
  sale: 'bg-accent-soft text-sale',
  new: 'bg-brand-soft text-brand',
  bestseller: 'bg-sun-soft text-sale',
  info: 'bg-sky-soft text-brand',
};

interface ProductCardProps {
  product: ProductCardView;
}

/** Wraps `children` in a link only when the card has one (none until the PDP ships in Phase 5). */
export function MaybeLink({ href, className, label, children }: { href: string | null; className?: string; label?: string; children: ReactNode }) {
  if (!href) return <div className={className}>{children}</div>;
  return (
    <Link href={href} aria-label={label} className={className}>
      {children}
    </Link>
  );
}

/**
 * Figma "Product Card" (1:9565, Size=Default 1:9566). Prices are paisa from the API - the card only
 * formats them. Real cards link to the PDP and add to the bag (Phase 5); placeholder demo cards have
 * no link and a disabled button. Wishlist and ratings are deferred (PHASE-5-CONTRACT §11).
 */
export function ProductCard({ product }: ProductCardProps) {
  return (
    <article className="flex h-full min-w-0 flex-col gap-4" data-sp-product={product.placeholder ? 'placeholder' : 'real'}>
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-sf-xs border border-line-subtle bg-sunken sm:aspect-auto sm:h-[320px]">
        <MaybeLink href={product.href} label={product.name} className="absolute inset-0">
          <ProductImage image={product.image} sizes="(min-width: 1024px) 25vw, 50vw" unoptimized={product.image_unoptimized} />
        </MaybeLink>
        {product.badge ? (
          <span
            className={`type-label-s pointer-events-none absolute top-[15px] left-[15px] rounded-full px-3 py-1 ${BADGE_TONES[product.badge.tone]}`}
          >
            {product.badge.label}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 px-1">
        {product.subtitle ? <p className="type-label-s text-ink-muted">{product.subtitle}</p> : null}
        <h3 className="type-label-m text-ink">
          {product.href ? (
            <Link href={product.href} className="hover:underline">
              {product.name}
            </Link>
          ) : (
            product.name
          )}
        </h3>
        {product.rating !== null ? (
          <p className="type-label-s flex items-center gap-1">
            <Icon name="star" className="text-sale" />
            <span className="text-ink">{product.rating.toFixed(1)}</span>
            <span className="text-ink-muted">({product.review_count})</span>
          </p>
        ) : null}
      </div>

      <div className="flex items-baseline gap-2 px-1">
        <p className="type-price-m text-ink">{formatMoney(product.price_amount, product.currency)}</p>
        {product.compare_at_amount !== null ? (
          <p className="type-body-s leading-[1.3] text-ink-muted">
            <span className="sr-only">Was </span>
            {formatMoney(product.compare_at_amount, product.currency)}
          </p>
        ) : null}
      </div>

      {product.href ? (
        <QuickAddButton slug={product.slug} name={product.name} className="mt-auto" />
      ) : (
        <button
          type="button"
          disabled
          className="type-label-m mt-auto flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-control bg-brand px-5 py-3 text-on-brand opacity-60"
        >
          Add to cart
          <Icon name="bag-inverse" />
        </button>
      )}
    </article>
  );
}
