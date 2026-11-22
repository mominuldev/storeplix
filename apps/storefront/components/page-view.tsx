import Link from 'next/link';
import type { StoreContact } from '@storeplix/types';
import type { SafeStorefrontPage } from '@/lib/storefront-schemas';
import { telHref, whatsappHref } from '@/lib/contact';
import { Icon } from '@/themes/modern-commerce/components/icon';
import { PageBlocks, headingAnchor } from './page-blocks';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dhaka' });

/**
 * Merchant page layout (Figma Policy page 149:1294): breadcrumb, H1, "Updated {date}", "On this page"
 * (two or more H2 blocks), blocks and a
 * "Questions? Talk to us" contact card (aside on desktop) when the store has a phone or WhatsApp.
 */
export function PageView({ page, contact }: { page: SafeStorefrontPage; contact: StoreContact }) {
  const tel = telHref(contact.phone);
  const wa = whatsappHref(contact.whatsapp);
  const updated = page.updated_at ? DATE.format(new Date(page.updated_at)) : null;
  // "On this page" (149:1453) lists the page's H2 blocks once there are at least two to jump between.
  const toc = page.body.flatMap((b) => (b.type === 'heading' && b.level !== 3 ? [{ id: headingAnchor(b.id), text: b.text }] : []));

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-4 pt-6 pb-8 md:gap-8 md:px-10 md:py-12 lg:flex-row lg:gap-16 lg:px-20 lg:py-16">
      <article className="flex min-w-0 flex-1 flex-col gap-4 md:gap-6 lg:max-w-[760px]">
        <nav aria-label="Breadcrumb" className="type-body-s text-ink-muted max-md:text-[12px]">
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
        <header className="flex flex-col gap-4 md:gap-3">
          <h1 className="type-display-m text-ink max-md:text-[28px] max-md:leading-[1.16] max-md:tracking-[-0.5px]">{page.title}</h1>
          {updated ? <p className="type-body-s text-ink-muted max-md:text-[13px]">Updated {updated}</p> : null}
        </header>
        {toc.length >= 2 ? (
          <nav aria-label="On this page" className="flex flex-col gap-1.5 rounded-sf-lg bg-sunken p-3.5">
            <p className="type-label-s text-ink-secondary">On this page</p>
            <ol className="flex flex-col gap-1.5">
              {toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} className="type-label-m text-brand hover:underline max-md:text-[14px] max-md:font-medium">
                    {t.text}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <PageBlocks blocks={page.body} media={page.media} />
      </article>
      {tel || wa ? (
        <aside className="lg:w-[320px] lg:shrink-0">
          <div className="flex flex-col gap-2.5 rounded-sf-xl bg-brand-soft p-4 text-[#0e1a33] md:gap-4 md:p-5 lg:sticky lg:top-8">
            <p className="type-label-m max-md:text-[16px]">Questions? Talk to us</p>
            <div className="flex gap-2.5 md:gap-2">
              {tel ? (
                <a href={tel} className="type-label-m flex flex-1 items-center justify-center gap-2 rounded-control border border-line bg-surface px-4 py-3">
                  <Icon name="phone" />
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
                  <Icon name="whatsapp" size={16} />
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
