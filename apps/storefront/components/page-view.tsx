import Link from 'next/link';
import type { StoreContact } from '@storeplix/types';
import type { SafeStorefrontPage } from '@/lib/storefront-schemas';
import { telHref, whatsappHref } from '@/lib/contact';
import { PageBlocks } from './page-blocks';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dhaka' });

/**
 * Merchant page layout (Figma Policy page 149:1294): breadcrumb, H1, "Updated {date}", blocks and a
 * "Questions? Talk to us" contact card (aside on desktop) when the store has a phone or WhatsApp.
 */
export function PageView({ page, contact }: { page: SafeStorefrontPage; contact: StoreContact }) {
  const tel = telHref(contact.phone);
  const wa = whatsappHref(contact.whatsapp);
  const updated = page.updated_at ? DATE.format(new Date(page.updated_at)) : null;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-4 py-8 lg:flex-row lg:gap-16 lg:px-20 lg:py-16">
      <article className="flex min-w-0 flex-1 flex-col gap-6 lg:max-w-[760px]">
        <nav aria-label="Breadcrumb" className="type-body-s text-ink-muted">
          <ol className="flex flex-wrap items-center gap-1">
            <li>
              <Link href="/" className="hover:underline">
                Home
              </Link>
            </li>
            <li aria-hidden>›</li>
            <li aria-current="page" className="truncate">
              {page.title}
            </li>
          </ol>
        </nav>
        <header className="flex flex-col gap-3">
          <h1 className="type-display-m text-ink max-md:text-[32px]">{page.title}</h1>
          {updated ? <p className="type-body-s text-ink-muted">Updated {updated}</p> : null}
        </header>
        <PageBlocks blocks={page.body} media={page.media} />
      </article>
      {tel || wa ? (
        <aside className="lg:w-[320px] lg:shrink-0">
          <div className="flex flex-col gap-4 rounded-sf-xl bg-brand-soft p-5 text-[#0e1a33] lg:sticky lg:top-8">
            <p className="type-label-m">Questions? Talk to us</p>
            <div className="flex gap-2">
              {tel ? (
                <a href={tel} className="type-label-m flex flex-1 items-center justify-center gap-2 rounded-control border border-line bg-surface px-4 py-3">
                  Call us
                </a>
              ) : null}
              {wa ? (
                <a
                  href={wa}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="type-label-m flex flex-1 items-center justify-center gap-2 rounded-control bg-[#14833b] px-4 py-3 text-white"
                >
                  WhatsApp
                </a>
              ) : null}
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
