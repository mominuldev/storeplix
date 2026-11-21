import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { requireCurrentStore } from '@/lib/store';
import { originForHost } from '@/lib/seo';
import { sanitizeImageUrl } from '@/lib/sanitize';

export async function generateMetadata(): Promise<Metadata> {
  const { host, config } = await requireCurrentStore();
  const origin = originForHost(host);
  const title = config.seo.title || config.store.name;
  const description = config.seo.description ?? undefined;
  const favicon = sanitizeImageUrl(config.store.favicon_url);
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
    icons: favicon ? { icon: favicon } : undefined,
  };
}

export default async function StoreLayout({ children }: { children: ReactNode }) {
  const { theme, themeConfig, config } = await requireCurrentStore();
  const { Layout } = theme;
  return (
    <Layout store={config.store} settings={themeConfig.settings} description={config.seo.description}>
      {children}
    </Layout>
  );
}
