import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireCurrentStore } from '@/lib/store';
import { getPreviewToken } from '@/lib/preview';
import { getAvailability, getProduct, listProducts } from '@/lib/commerce-api';
import { getStorefrontPageIndex } from '@/lib/storefront-api';
import { canonicalOrigin, isIndexable, NOINDEX_ROBOTS } from '@/lib/seo';
import { isAllowedMediaOrigin } from '@/lib/media';
import { whatsappHref } from '@/lib/contact';
import { productJsonLd, richTextPlain, toPdpVariants } from '@/lib/pdp';
import { toCardView } from '@/lib/products';
import { policyLinks } from '@/lib/policy-pages';
import { JsonLd } from '@/components/json-ld';
import { RichText } from '@/components/rich-text';
import { ProductView, type PdpImage } from '@/themes/modern-commerce/commerce/product-view';
import { DeliveryBox } from '@/themes/modern-commerce/commerce/delivery-box';
import { ShareButton } from '@/themes/modern-commerce/commerce/share-button';
import { Breadcrumb } from '@/themes/modern-commerce/commerce/ui';
import { ProductCard } from '@/themes/modern-commerce/components/product-card';
import { SectionHeader } from '@/themes/modern-commerce/components/section-header';
import { Icon } from '@/themes/modern-commerce/components/icon';
import Link from 'next/link';

interface Props {
  params: Promise<{ slug: string }>;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function load(slug: string) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon' || !SLUG_RE.test(slug) || slug.length > 200) return { store, product: null, token: null };
  // Public: tagged shared cache. Preview: token forwarded, no-store (drafts visible, P5-24).
  const token = store.mode === 'preview' ? await getPreviewToken() : null;
  return { store, product: await getProduct(store.host, slug, token), token };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const { store, product } = await load(slug);
  if (!product) return {};
  const { config, host, mode } = store;
  const url = `${canonicalOrigin(config.store, host)}/products/${product.slug}`;
  const title = product.seo.title || product.name;
  const description = product.seo.description ?? richTextPlain(product.description) ?? config.seo.description ?? undefined;
  const image = product.images[0]?.media.url;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', siteName: config.store.name, title, description, url, images: image ? [{ url: image }] : undefined },
    twitter: { card: 'summary_large_image', title, description, images: image ? [image] : undefined },
    robots: isIndexable(mode, config.seo) && !product.is_preview_only ? undefined : NOINDEX_ROBOTS,
  };
}

/** PDP `/products/{slug}` — Figma desktop 1:11034, mobile 1:11250 (PHASE-5-CONTRACT §5). */
export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const { store, product, token } = await load(slug);
  if (store.mode === 'coming_soon') return null; // layout renders Coming soon
  if (!product) notFound();

  const { config, host, mode } = store;
  const origin = canonicalOrigin(config.store, host);
  const primary = product.categories[0];
  const [related, pages, availability] = await Promise.all([
    primary
      ? listProducts(host, new URLSearchParams({ category: primary.slug, exclude: product.id, limit: '4', sort: 'bestsellers' }), token)
      : Promise.resolve(null),
    getStorefrontPageIndex(host),
    // Only for JSON-LD InStock/OutOfStock on live pages; never rendered as numbers.
    mode === 'live' ? getAvailability(host, product.slug, null) : Promise.resolve(null),
  ]);
  const policies = policyLinks(pages);
  const inStock = availability ? availability.variants.some((v) => v.available) : true;

  const images: PdpImage[] = product.images.map((i) => ({
    url: i.media.url,
    alt: i.alt ?? i.media.alt ?? '',
    unoptimized: !i.media.url.startsWith('/') && !isAllowedMediaOrigin(i.media.url),
  }));
  const wa = whatsappHref(config.contact.whatsapp);
  const waLink = wa ? `${wa}?text=${encodeURIComponent(`Hi! I have a question about ${product.name}: ${origin}/products/${product.slug}`)}` : null;
  const pairs = (related?.products ?? []).filter((p) => p.id !== product.id).slice(0, 4).map(toCardView);

  const heading = (
    <div className="flex flex-col gap-3">
      {product.is_preview_only ? (
        <p className="type-label-s self-start rounded-full bg-sun-soft px-3 py-1 text-sale">Draft · only visible in preview</p>
      ) : null}
      {primary ? (
        <Link href={`/c/${primary.slug}`} className="type-eyebrow self-start text-brand hover:underline">
          {primary.name}
        </Link>
      ) : null}
      <h1 className="type-display-m break-words text-ink">{product.name}</h1>
    </div>
  );

  const details = (
    <div className="flex flex-col gap-6">
      <DeliveryBox commerce={config.commerce} currency={product.currency} />
      <div className="border-t border-line-subtle">
        {product.description ? (
          <details open className="group border-b border-line-subtle py-4">
            <summary className="type-label-m flex cursor-pointer list-none items-center justify-between text-ink">
              Description
              <Icon name="plus" className="transition group-open:rotate-45" />
            </summary>
            <div className="type-body-m pt-3 text-ink-secondary">
              <RichText doc={product.description} />
            </div>
          </details>
        ) : null}
        <details className="group border-b border-line-subtle py-4">
          <summary className="type-label-m flex cursor-pointer list-none items-center justify-between text-ink">
            Delivery &amp; returns
            <Icon name="plus" className="transition group-open:rotate-45" />
          </summary>
          <div className="type-body-s flex flex-col gap-2 pt-3 text-ink-secondary">
            <p>Delivery charge is set by your area at checkout. Pay in cash when your parcel arrives.</p>
            {policies.length ? (
              <ul className="flex flex-col gap-1">
                {policies.map((p) => (
                  <li key={p.href}>
                    <Link href={p.href} className="text-brand underline">
                      {p.label}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        {waLink ? (
          <a href={waLink} target="_blank" rel="noopener noreferrer" className="type-label-s flex items-center gap-2 text-brand hover:underline">
            <Icon name="whatsapp" />
            Ask about this on WhatsApp
          </a>
        ) : null}
        <ShareButton title={product.name} url={`${origin}/products/${product.slug}`} />
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-16 px-4 pt-6 pb-16 lg:gap-24 lg:px-20 lg:pt-8 lg:pb-24">
      {mode === 'live' && !product.is_preview_only ? <JsonLd data={productJsonLd(product, origin, inStock, richTextPlain(product.description, 500))} /> : null}
      <div className="flex flex-col gap-6 lg:gap-8">
        <Breadcrumb items={[{ label: 'Home', href: '/' }, ...(primary ? [{ label: primary.name, href: `/c/${primary.slug}` }] : []), { label: product.name }]} />
        <ProductView
          slug={product.slug}
          name={product.name}
          currency={product.currency}
          options={product.options}
          variants={toPdpVariants(product)}
          images={images}
          heading={heading}
          details={details}
        />
      </div>
      {pairs.length > 0 && primary ? (
        <section aria-labelledby="pairs-title" className="flex flex-col gap-8 lg:gap-10">
          <SectionHeader id="pairs-title" eyebrow="Complete the look" title="Pairs well with" linkLabel="View all" linkHref={`/c/${primary.slug}`} />
          <div className="grid grid-cols-2 gap-x-3 gap-y-8 lg:grid-cols-4 lg:gap-6">
            {pairs.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
