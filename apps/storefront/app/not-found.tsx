import { ThemeNotFound } from '@/themes/modern-commerce/not-found';
import { findCurrentStore, isCurrentStoreSuspended } from '@/lib/store';
import { StoreUnavailable } from '@/components/store-unavailable';

/**
 * Two cases share Next's single root 404 boundary:
 *  - unknown host            -> platform-branded "Store not found"
 *  - known store, bad path   -> "Page not found" inside the store's theme
 * Phase 8.1: a suspended shop has no store here; it gets the bare "temporarily unavailable" page (normally the
 * proxy already answered with the 503 version).
 */
export default async function NotFound() {
  if (await isCurrentStoreSuspended().catch(() => false)) return <StoreUnavailable />;
  const store = await findCurrentStore().catch(() => null);

  if (store?.mode === 'coming_soon') {
    const { ComingSoon } = store.theme;
    return <ComingSoon
        store={store.config.store}
        settings={store.themeConfig.settings}
        contact={store.config.contact}
        social={store.config.social}
      />;
  }

  if (store) {
    const { Layout } = store.theme;
    return (
      <Layout
        store={store.config.store}
        settings={store.themeConfig.settings}
        navigation={store.config.navigation}
        description={store.config.seo.description}
        contact={store.config.contact}
        social={store.config.social}
      >
        <ThemeNotFound />
      </Layout>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-surface-canvas px-6 text-center font-[family-name:var(--font-inter)] text-text-primary">
      <img src="/platform/storeplix-horizontal.svg" alt="Store Plix" width={160} height={64} className="h-10 w-auto" />
      <div className="flex max-w-md flex-col gap-2 rounded-card bg-surface-card p-8 shadow-elevation-1">
        <p className="text-caption font-medium text-brand-600">404</p>
        <h1 className="text-heading-24 text-text-primary">Store not found</h1>
        <p className="text-body text-text-secondary">
          There’s no store at this address yet. Check the URL, or create your own store on Store Plix in minutes.
        </p>
      </div>
      <a href="https://storeplix.com" className="rounded-md bg-brand-600 px-4 py-2.5 text-body font-semibold text-text-inverse hover:bg-brand-700">
        Go to Store Plix
      </a>
    </main>
  );
}
