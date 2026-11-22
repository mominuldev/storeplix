import type { SectionProps } from '../../types';
import type { FeaturedProductsSettings } from '../schema';
import { getFeaturedProducts } from '@/lib/products';
import { ProductCard } from '../components/product-card';
import { SectionHeader } from '../components/section-header';

/**
 * Figma "New arrivals" (1:10225) and "Bestsellers" (1:10279): Section Header + 4-column Product Card
 * grid. Real products from the feed (fewer than `limit` is fine); placeholders while the store has none.
 */
export async function FeaturedProductsSection({ id, settings: s, ctx }: SectionProps<FeaturedProductsSettings>) {
  const products = await getFeaturedProducts(ctx.host, s.limit, s.source, { preview: ctx.preview });
  if (products.length === 0) return null;

  return (
    <div className="flex flex-col gap-5 px-4 md:gap-8 md:px-10 lg:gap-10 lg:px-20">
      <SectionHeader id={`${id}-title`} eyebrow={s.eyebrow} title={s.title} linkLabel={s.linkLabel} linkHref={s.linkHref ?? undefined} />
      {/* Phone 1:10414 2-col (24/12 gaps), tablet 1:10568 one row of 3, desktop 4 across. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 md:grid-cols-3 md:gap-4 lg:grid-cols-4 lg:gap-6 md:max-lg:[&>*:nth-child(n+4)]:hidden">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </div>
  );
}
