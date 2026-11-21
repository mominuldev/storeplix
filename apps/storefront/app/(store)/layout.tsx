import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { requireCurrentStore } from '@/lib/store';
import { originForHost } from '@/lib/seo';
import { sanitizeImageUrl } from '@/lib/sanitize';
import { PreviewBanner } from '@/components/preview-banner';

export async function generateMetadata(): Promise<Metadata> {
  const { host, config, mode } = await requireCurrentStore();
  const origin = originForHost(host);
  const favicon = sanitizeImageUrl(config.store.favicon_url);
  const icons = favicon ? { icon: favicon } : undefined;

  // Draft (Coming soon) and preview renders must never be indexed.
  if (mode !== 'live') {
    return {
      metadataBase: new URL(origin),
      title: mode === 'coming_soon' ? `${config.store.name} · Coming soon` : `Preview · ${config.store.name}`,
      robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
      icons,
    };
  }

  const title = config.seo.title || config.store.name;
  const description = config.seo.description ?? undefined;
  const logo = sanitizeImageUrl(config.store.logo_url);
  return {
    metadataBase: new URL(origin),
    title: { default: title, template: `%s · ${config.store.name}` },
    description,
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      siteName: config.store.name,
      title,
      description,
      url: origin,
      images: logo ? [{ url: logo }] : undefined,
    },
    twitter: { card: 'summary_large_image', title, description },
    icons,
  };
}

export default async function StoreLayout({ children }: { children: ReactNode }) {
  const { theme, themeConfig, config, mode } = await requireCurrentStore();

  // Every path of a draft store (without a valid preview) renders Coming soon, status 200.
  if (mode === 'coming_soon') {
    const { ComingSoon } = theme;
    return <ComingSoon store={config.store} settings={themeConfig.settings} />;
  }

  const { Layout } = theme;
  return (
    <>
      {mode === 'preview' ? <PreviewBanner isPublic={config.store.status === 'active'} /> : null}
      <Layout store={config.store} settings={themeConfig.settings} description={config.seo.description}>
        {children}
      </Layout>
    </>
  );
}
