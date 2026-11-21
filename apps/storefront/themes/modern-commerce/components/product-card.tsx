import Link from 'next/link';
import type { StorefrontProductCard } from '@/lib/products';
import { formatPrice } from '@/lib/format';
import { Icon } from './icon';
import { ThemeImage } from './theme-image';

const BADGE_TONES: Record<NonNullable<StorefrontProductCard['badge']>['tone'], string> = {
  sale: 'bg-accent-soft text-sale',
  new: 'bg-brand-soft text-brand',
  bestseller: 'bg-sun-soft text-sale',
  info: 'bg-sky-soft text-brand',
};

interface ProductCardProps {
  product: StorefrontProductCard;
  currency: string;
}

/**
 * Figma "Product Card" (1:9565, Size=Default 1:9566). Prices come from the API - the card never
 * computes a price. Wishlist / Add to cart are links until cart APIs exist.
 */
export function ProductCard({ product, currency }: ProductCardProps) {
  const href = `/products/${encodeURIComponent(product.slug)}`;
  return (
    <article className="flex min-w-0 flex-col gap-4">
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-sf-xs border border-line-subtle bg-sunken sm:aspect-auto sm:h-[320px]">
        <Link href={href} aria-label={product.name} className="absolute inset-0">
          <ThemeImage src={product.image_url} alt="" sizes="(min-width: 1024px) 25vw, 50vw" />
        </Link>
        {product.badge ? (
          <span
            className={`type-label-s pointer-events-none absolute top-[15px] left-[15px] rounded-full px-3 py-1 ${BADGE_TONES[product.badge.tone]}`}
          >
            {product.badge.label}
          </span>
        ) : null}
        <button
          type="button"
          aria-label={`Add ${product.name} to wishlist`}
          className="absolute top-[15px] right-[15px] flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink hover:bg-sunken"
        >
          <Icon name="heart" />
        </button>
      </div>

      <div className="flex flex-col gap-2 px-1">
        {product.subtitle ? <p className="type-label-s text-ink-muted">{product.subtitle}</p> : null}
        <h3 className="type-label-m text-ink">
          <Link href={href} className="hover:underline">
            {product.name}
          </Link>
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
        <p className="type-price-m text-ink">{formatPrice(product.price, currency)}</p>
        {product.compare_at_price !== null ? (
          <p className="type-body-s leading-[1.3] text-ink-muted">
            <span className="sr-only">Was </span>
            {formatPrice(product.compare_at_price, currency)}
          </p>
        ) : null}
      </div>

      <Link
        href={href}
        className="type-label-m flex w-full items-center justify-center gap-2 rounded-control bg-brand px-5 py-3 text-on-brand hover:brightness-110"
      >
        Add to cart
        <Icon name="bag-inverse" />
      </Link>
    </article>
  );
}
