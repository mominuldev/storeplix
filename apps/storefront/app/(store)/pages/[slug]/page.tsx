import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireCurrentStore } from '@/lib/store';
import { getPreviewToken } from '@/lib/preview';
import { getStorefrontPage } from '@/lib/storefront-api';
import { canonicalOrigin, isIndexable, NOINDEX_ROBOTS } from '@/lib/seo';
import { sanitizeImageUrl } from '@/lib/sanitize';
import { isPageSlug } from '@/lib/storefront-schemas';
import { PageView } from '@/components/page-view';

interface Props {
  params: Promise<{ slug: string }>;
}

async function load(slug: string) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon' || !isPageSlug(slug)) return { store, page: null };
  // Public: published pages only (tagged cache). Preview token: drafts/hidden too (no-store).
  const token = store.mode === 'preview' ? await getPreviewToken() : null;
  return { store, page: await getStorefrontPage(store.host, slug, token) };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const { store, page } = await load(slug);
  if (!page) return {};
  const { config, host, mode } = store;
  const url = `${canonicalOrigin(config.store, host)}/pages/${page.slug}`;
  const title = page.seo.title || page.title;
  const description = page.seo.description ?? config.seo.description ?? undefined;
  const image = page.seo.og_image_url ?? config.seo.og_image_url ?? sanitizeImageUrl(config.store.logo_url);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', siteName: config.store.name, title, description, url, images: image ? [{ url: image }] : undefined },
    twitter: { card: 'summary_large_image', title, description, images: image ? [image] : undefined },
    robots: isIndexable(mode, config.seo) ? undefined : NOINDEX_ROBOTS,
  };
}

/** `/pages/{slug}`: a merchant page (Figma Policy page 149:1294, V1 Edit page preview 74:22532). */
export default async function StorePage({ params }: Props) {
  const { slug } = await params;
  const { store, page } = await load(slug);
  if (store.mode === 'coming_soon') return null; // layout renders Coming soon
  if (!page) notFound();
  return <PageView page={page} contact={store.config.contact} />;
}
