import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { findCurrentStore } from '@/lib/store';
import { notFound } from 'next/navigation';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { getClientIp } from '@/lib/commerce-api';
import { getUnsubscribeStatus } from '@/lib/storefront-api';
import { copyFor, screenFor, type UnsubscribeScreen } from './copy';

// PHASE-8-5 §8.6 / P85-7: the unsubscribe page on the merchant's own host. GET never changes state (link scanners,
// SMS previewers): the shopper presses a button (form POST → `/u/{code}/change` → 303 back here). `noindex`,
// `Cache-Control: private, no-store` (proxy). Lives outside the `(store)` group so a draft shop (Coming soon on every other path) still renders it; live
// and preview shops get the theme layout around it. A suspended shop never reaches here (proxy 503 page).

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Unsubscribe',
  robots: NOINDEX_ROBOTS,
  referrer: 'no-referrer',
};

interface Props {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ e?: string }>;
}

export default async function UnsubscribePage({ params, searchParams }: Props) {
  const store = await findCurrentStore();
  if (!store) notFound();
  const { code } = await params;
  const failed = (await searchParams).e === '1';
  const screen = screenFor(await getUnsubscribeStatus(store.host, code, await getClientIp()));
  const card = <UnsubscribeCard code={code} screen={screen} failed={failed} storeName={store.config.store.name} />;

  if (store.mode === 'coming_soon') {
    return <main className="theme-root flex min-h-dvh flex-col items-center justify-center px-4 py-16">{card}</main>;
  }
  const { Layout } = store.theme;
  const { config, themeConfig } = store;
  return (
    <Layout
      store={config.store}
      settings={themeConfig.settings}
      navigation={config.navigation}
      description={config.seo.description}
      contact={config.contact}
      social={config.social}
      commerce={config.commerce}
    >
      <div className="flex justify-center px-4 py-16 lg:py-24">{card}</div>
    </Layout>
  );
}

const button =
  'type-label-m flex h-[52px] w-full items-center justify-center rounded-control px-7 disabled:opacity-60 sm:w-auto';

function UnsubscribeCard({
  code,
  screen,
  failed,
  storeName,
}: {
  code: string;
  screen: UnsubscribeScreen;
  failed: boolean;
  storeName: string;
}) {
  const { title, body } = copyFor(screen);
  let action: ReactNode = null;
  if (screen.kind === 'subscribed') {
    action = (
      <form method="post" action={`/u/${code}/change`}>
        <button
          type="submit"
          name="action"
          value="unsubscribe"
          className={`${button} bg-brand text-on-brand hover:brightness-110`}
        >
          Unsubscribe
        </button>
      </form>
    );
  } else if (screen.kind === 'unsubscribed') {
    action = (
      <form method="post" action={`/u/${code}/change`}>
        <button
          type="submit"
          name="action"
          value="resubscribe"
          className={`${button} border-[1.5px] border-ink text-ink hover:bg-ink/5`}
        >
          Subscribe again
        </button>
      </form>
    );
  }
  return (
    <section
      aria-labelledby="unsubscribe-title"
      data-sp-unsubscribe={screen.kind}
      className="flex w-full max-w-[520px] flex-col items-center gap-5 rounded-sf-xs border border-line bg-surface px-6 py-10 text-center sm:px-10"
    >
      <p className="type-label-s text-ink-muted">{'storeName' in screen ? screen.storeName : storeName}</p>
      <h1 id="unsubscribe-title" className="type-h1 text-ink">
        {title}
      </h1>
      <p className="type-body-m text-ink-secondary">{body}</p>
      {failed && (
        <p role="alert" className="type-body-s text-ink">
          That didn’t go through. Please wait a minute and try again.
        </p>
      )}
      {action}
    </section>
  );
}
