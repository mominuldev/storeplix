import type { SectionProps } from '../../types';
import type { FeaturedProductsSettings } from '../schema';
import { getFeaturedProducts } from '@/lib/products';
import { ProductCard } from '../components/product-card';
import { SectionHeader } from '../components/section-header';

/** Figma "New arrivals" (1:10225): Section Header + 4-column Product Card grid (1:10233). */
export async function FeaturedProductsSection({ settings: s, store, host }: SectionProps<FeaturedProductsSettings>) {
  const products = await getFeaturedProducts(host, s.limit);
  if (products.length === 0) return null;
  const headingId = `featured-${s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-8 px-4 pb-16 lg:gap-10 lg:px-20 lg:pb-28">
      <SectionHeader id={headingId} eyebrow={s.eyebrow} title={s.title} linkLabel={s.linkLabel} linkHref={s.linkHref} />
      <div className="grid grid-cols-2 gap-x-3 gap-y-8 lg:grid-cols-4 lg:gap-6">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} currency={store.currency} />
        ))}
      </div>
    </section>
  );
}
