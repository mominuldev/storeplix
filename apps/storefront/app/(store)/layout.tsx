import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { requireCurrentStore } from '@/lib/store';
import { canonicalOrigin, isIndexable, NOINDEX_ROBOTS } from '@/lib/seo';
import { sanitizeImageUrl } from '@/lib/sanitize';
import { storeJsonLd } from '@/lib/json-ld';
import { isEmbeddedPreview } from '@/lib/preview';
import { parseEditorOrigins } from '@/lib/editor-origins';
import { PreviewBanner } from '@/components/preview-banner';
import { PreviewBridge } from '@/components/preview-bridge';
import { JsonLd } from '@/components/json-ld';
import { manifestIcons, storeIconsMetadata } from '@/lib/store-icons';

export async function generateMetadata(): Promise<Metadata> {
  const { host, config, mode } = await requireCurrentStore();
  const origin = canonicalOrigin(config.store, host);
  const icons = storeIconsMetadata(config.store);
  const manifest = manifestIcons(config.store).length > 0 ? '/manifest.webmanifest' : undefined;

  // Draft (Coming soon) and preview renders must never be indexed.
  if (mode !== 'live') {
    return {
      metadataBase: new URL(origin),
      title: mode === 'coming_soon' ? `${config.store.name} · Coming soon` : `Preview · ${config.store.name}`,
      robots: NOINDEX_ROBOTS,
      icons,
      manifest,
    };
  }

  const title = config.seo.title || config.store.name;
  const description = config.seo.description ?? undefined;
  const shareImage = config.seo.og_image_url ?? sanitizeImageUrl(config.store.logo_url);
  return {
    metadataBase: new URL(origin),
    title: { default: title, template: `%s · ${config.store.name}` },
    description,
    alternates: { canonical: `${origin}/` },
    openGraph: {
      type: 'website',
      siteName: config.store.name,
      title,
      description,
      url: `${origin}/`,
      images: shareImage ? [{ url: shareImage }] : undefined,
    },
    twitter: { card: 'summary_large_image', title, description, images: shareImage ? [shareImage] : undefined },
    robots: isIndexable(mode, config.seo) ? undefined : NOINDEX_ROBOTS,
    icons,
    manifest,
  };
}

export default async function StoreLayout({ children }: { children: ReactNode }) {
  const { host, theme, themeConfig, config, mode } = await requireCurrentStore();

  // Every path of a draft store (without a valid preview) renders Coming soon, status 200.
  if (mode === 'coming_soon') {
    const { ComingSoon } = theme;
    return <ComingSoon store={config.store} settings={themeConfig.settings} contact={config.contact} social={config.social} />;
  }

  const embedded = mode === 'preview' && (await isEmbeddedPreview());
  const { Layout } = theme;
  return (
    <>
      {mode === 'live' ? (
        <JsonLd
          data={storeJsonLd({
            name: config.store.name,
            origin: canonicalOrigin(config.store, host),
            logoUrl: config.store.logo_url,
            contact: config.contact,
            social: config.social,
          })}
        />
      ) : null}
      {mode === 'preview' && !embedded ? <PreviewBanner isPublic={config.store.status === 'active'} /> : null}
      {embedded ? <PreviewBridge allowedOrigins={parseEditorOrigins()} /> : null}
      <Layout
        store={config.store}
        settings={themeConfig.settings}
        navigation={config.navigation}
        description={config.seo.description}
        contact={config.contact}
        social={config.social}
        commerce={config.commerce}
      >
        {children}
      </Layout>
    </>
  );
}
