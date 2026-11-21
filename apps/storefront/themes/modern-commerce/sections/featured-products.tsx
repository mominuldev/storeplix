import type { SectionProps } from '../../types';
import type { FeaturedProductsSettings } from '../schema';
import { getFeaturedProducts } from '@/lib/products';
import { ProductCard } from '../components/product-card';
import { SectionHeader } from '../components/section-header';

/**
 * Figma "New arrivals" (1:10225) and "Bestsellers" (1:10279): Section Header + 4-column Product Card
 * grid. PLACEHOLDER products until the catalog API exists (Phase 5).
 */
export async function FeaturedProductsSection({ id, settings: s, ctx }: SectionProps<FeaturedProductsSettings>) {
  const products = await getFeaturedProducts(ctx.host, s.limit, s.source);
  if (products.length === 0) return null;

  return (
    <div className="flex flex-col gap-8 px-4 lg:gap-10 lg:px-20">
      <SectionHeader id={`${id}-title`} eyebrow={s.eyebrow} title={s.title} linkLabel={s.linkLabel} linkHref={s.linkHref ?? undefined} />
      <div className="grid grid-cols-2 gap-x-3 gap-y-8 lg:grid-cols-4 lg:gap-6">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} currency={ctx.store.currency} />
        ))}
      </div>
    </div>
  );
}
