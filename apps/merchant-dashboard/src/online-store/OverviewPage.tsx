import { Button, cn } from '@storeplix/ui';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { usePreviewStore } from '../stores/usePreviewStore';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';
import { countChanges } from './editor/changes';
import { relativeTime, useActiveTheme, useNavigationMenus, useStorePages } from './hooks';
import { OnlineStoreHeader } from './components/Shell';
import { styleSummary, themeThumbnail } from './themeAssets';

// Figma V3 Overview 2028:44401 (Main 2028:44403). Built: hero card (shop name, live/draft badge, theme name,
// "N theme changes waiting", Customise theme, Preview) and "Your website, part by part" (Theme & brand style,
// Pages, Navigation, Domain & SEO — SEO part only). Stats row, "steps left" and Landing pages/Popups cards are
// out of scope (no data yet).

export function OverviewPage() {
  const navigate = useNavigate();
  const store = useTenantStore().data!;
  const preview = usePreviewStore();
  const { summary, theme } = useActiveTheme();
  const pages = useStorePages();
  const menus = useNavigationMenus();
  const draft = theme.data?.draft_config;
  const changes = draft ? countChanges(draft, theme.data?.published_config) : 0;
  const style = styleSummary(theme.data?.published_config ?? draft);
  const domain = storeDomain(store);
  const counts = pages.data?.meta.counts;
  const main = menus.data?.find((m) => m.handle === 'main');
  const linkCount = (h: string) => menus.data?.find((m) => m.handle === h)?.items.reduce((n, i) => n + 1 + (i.children?.length ?? 0), 0) ?? 0;

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      <OnlineStoreHeader title="Online store" description="Everything buyers see — your theme, pages, domain and how the shop behaves." />

      <section
        aria-label="Your shop"
        className="grid gap-6 overflow-hidden rounded-[20px] border border-border-default bg-[linear-gradient(135.5deg,var(--color-brand-50)_0%,var(--color-surface-card)_40.7%)] p-5 shadow-elevation-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,576px)] lg:items-center lg:gap-10 lg:px-9 lg:pt-9 lg:pb-7"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-2.5 text-[13px] leading-[18px] font-medium',
                store.status === 'active' ? 'bg-success-bg text-success' : 'bg-surface-subtle text-text-secondary',
              )}
            >
              <span aria-hidden className="size-[7px] rounded-full bg-current" />
              {store.status === 'active' ? 'Live' : 'Coming soon'}
            </span>
            {summary && (
              <span className="inline-flex items-center rounded-full border border-border-default bg-surface-card px-2.5 py-1 text-[13px] leading-[18px] font-medium text-text-secondary">
                {summary.name} theme
              </span>
            )}
          </div>
          <h2 className="text-[36px] leading-[44px] font-semibold tracking-[-0.72px] text-text-primary">{store.name}</h2>
          <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 self-start text-body-lg font-medium text-brand-700 hover:underline">
            {domain} <ExternalLink aria-hidden className="size-4" />
          </a>
          {summary?.published_at && (
            <p className="text-[14px] leading-[21px] text-text-secondary">
              Published {relativeTime(summary.published_at)}
              {summary.published_by ? ` by ${summary.published_by.name}` : ''}.{' '}
              {store.status === 'active' ? 'Anyone can browse and order.' : 'Buyers see a Coming soon page until you go live.'}
            </p>
          )}
          {changes > 0 && (
            <Link to="/online-store/editor?page=home" className="flex w-full items-center gap-2.5 rounded-lg bg-warning-bg px-3.5 py-2.5 text-[13px] leading-[18px] font-medium text-text-primary">
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
              <span className="min-w-0 flex-1">
                {changes} theme change{changes === 1 ? ' is' : 's are'} waiting to go live
              </span>
              <span className="shrink-0 font-semibold text-warning">Review →</span>
            </Link>
          )}
          <div className="flex flex-wrap gap-2.5 pt-1">
            <Button onClick={() => navigate('/online-store/editor?page=home')}>Customise theme</Button>
            <Button variant="secondary" loading={preview.isPending} onClick={() => preview.mutate(store.id)}>
              Preview
            </Button>
          </div>
        </div>
        <div className="hidden items-center justify-center overflow-hidden rounded-card bg-surface-subtle p-6 lg:flex">
          {summary && <img src={themeThumbnail({ name: summary.name, code: summary.code })} alt="" className="aspect-[528/317] w-full rounded-[11px] object-cover object-top shadow-elevation-1" />}
        </div>
      </section>

      <section aria-labelledby="parts" className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 id="parts" className="text-[18px] leading-[26px] font-semibold tracking-[-0.09px] text-text-primary">
            Your website, part by part
          </h2>
          <p className="text-[13px] leading-[18px] text-text-muted">Each card shows how that part is doing and the next thing worth doing.</p>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <PartCard
            art={<ThemeArt />}
            title="Theme & brand style"
            badge={changes > 0 ? <PartPill tone="warning">Draft</PartPill> : <PartPill tone="success">Published</PartPill>}
            lines={[`${summary?.name ?? 'Theme'} · ${style?.colourName ?? ''}`, changes > 0 ? `${changes} change${changes === 1 ? '' : 's'} not published` : 'Everything is live']}
            to="/online-store/editor?page=home"
            cta="Open editor"
          />
          <PartCard
            art={<PagesArt />}
            title="Pages"
            badge={<PartPill tone="success">{counts?.published ?? 0} live</PartPill>}
            lines={[`${counts?.all ?? 0} pages · 1 built-in`, counts?.draft ? `${counts.draft} draft${counts.draft === 1 ? '' : 's'} waiting` : 'No drafts']}
            to="/online-store/pages"
            cta="Manage pages"
          />
          <PartCard
            art={<NavArt />}
            title="Navigation"
            badge={<PartPill tone="success">Published</PartPill>}
            lines={[`${main?.title ?? 'Main menu'} · ${linkCount('main')} links`, `Footer ${linkCount('footer')} · Help ${linkCount('help')}`]}
            to="/online-store/navigation"
            cta="Edit menus"
          />
          <PartCard art={<SeoArt domain={domain} name={store.name} />} title="Domain & SEO" lines={[domain, 'Title, description and share image']} to="/online-store/seo" cta="Open SEO settings" />
        </ul>
      </section>
    </div>
  );
}

function PartPill({ tone, children }: { tone: 'success' | 'warning'; children: ReactNode }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-[5px] rounded-full px-2 py-0.5 text-[12px] leading-[18px] font-medium', tone === 'success' ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning')}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

// Figma 2034:46054 card illustrations: brand-50 stage 132 px tall, white shapes centred in it.
const artShadow = 'shadow-[0_6px_16px_0_rgb(26_26_77/0.12)]';

function ThemeArt() {
  return (
    <div className={cn('relative h-[88px] w-40 rounded-[10px] bg-surface-card', artShadow)}>
      <span className="absolute top-3.5 left-[18px] text-[30px] leading-[39px] font-semibold text-text-primary">Aa</span>
      <span className="absolute top-[22px] left-20 flex gap-1">
        <span className="size-4 rounded-full bg-brand-600" />
        <span className="size-4 rounded-full bg-accent-500" />
        <span className="size-4 rounded-full bg-text-primary" />
      </span>
      <span className="absolute top-[60px] left-[18px] h-4 w-[58px] rounded-[5px] bg-brand-600" />
      <span className="absolute top-[60px] left-[82px] h-4 w-[58px] rounded-[5px] border border-border-strong bg-surface-card" />
    </div>
  );
}

function PagesArt() {
  return (
    <div className="relative h-[132px] w-32 self-start">
      <span className="absolute top-[30px] left-0 h-[118px] w-24 rounded-lg bg-surface-card opacity-55" />
      <span className="absolute top-[22px] left-4 h-[118px] w-24 rounded-lg bg-surface-card opacity-80" />
      <span className={cn('absolute top-3.5 left-8 h-[118px] w-24 rounded-lg bg-surface-card', artShadow)}>
        <span className="absolute top-3 left-2.5 h-1.5 w-10 rounded-[3px] bg-brand-600" />
        <span className="absolute top-[26px] left-2.5 h-[30px] w-[76px] rounded-[4px] bg-brand-100" />
        <span className="absolute top-16 left-2.5 h-1 w-[60px] rounded-[2px] bg-border-strong" />
        <span className="absolute top-[74px] left-2.5 h-1 w-[70px] rounded-[2px] bg-border-strong" />
        <span className="absolute top-[84px] left-2.5 h-1 w-12 rounded-[2px] bg-border-strong" />
      </span>
    </div>
  );
}

function NavArt() {
  return (
    <div className={cn('relative h-24 w-60 rounded-[10px] bg-surface-card', artShadow)}>
      <span className="absolute top-3.5 left-3 h-2 w-[30px] rounded-[4px] bg-brand-600" />
      <span className="absolute top-[9px] left-[54px] flex text-[10px] leading-[13px] text-text-secondary">
        <span className="px-[7px] py-[3px]">Home</span>
        <span className="rounded-[6px] bg-brand-100 px-[7px] py-[3px] font-medium text-brand-700">Shop</span>
        <span className="px-[7px] py-[3px]">Offers</span>
        <span className="px-[7px] py-[3px]">Help</span>
      </span>
      <span className="absolute top-[34px] left-[88px] flex h-[52px] w-[92px] flex-col gap-0.5 rounded-[6px] border border-border-default bg-surface-card px-2.5 py-1.5 text-[9px] leading-[12px] text-text-secondary shadow-elevation-1">
        <span>All products</span>
        <span>Categories</span>
        <span>Brands</span>
      </span>
    </div>
  );
}

function SeoArt({ domain, name }: { domain: string; name: string }) {
  return (
    <div className={cn('relative flex h-24 w-[252px] flex-col rounded-[10px] bg-surface-card px-3.5 pt-2.5', artShadow)}>
      <span className="truncate text-[9px] leading-[12px] text-success">{domain} › home</span>
      <span className="mt-0.5 truncate text-[13px] leading-[17px] font-medium text-brand-600">{name}</span>
      <span className="mt-[5px] h-1 w-[220px] rounded-[2px] bg-border-default" />
      <span className="mt-1.5 h-1 w-[196px] rounded-[2px] bg-border-default" />
      <span className="mt-1.5 h-1 w-[150px] rounded-[2px] bg-border-default" />
      <span className="mt-2 h-2 w-[60px] rounded-[4px] bg-accent-100" />
    </div>
  );
}

function PartCard({ art, title, badge, lines, to, cta }: { art: ReactNode; title: string; badge?: ReactNode; lines: string[]; to: string; cta: string }) {
  return (
    <li className="flex flex-col gap-3.5 overflow-hidden rounded-card border border-border-default bg-surface-card px-2.5 pt-2.5 pb-4 shadow-elevation-1">
      <div aria-hidden className="flex h-[132px] items-center justify-center overflow-hidden rounded-lg bg-brand-50">
        {art}
      </div>
      <div className="flex flex-col gap-1 px-2">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 text-[15px] leading-[22px] font-semibold tracking-[-0.045px] text-text-primary">{title}</h3>
          {badge}
        </div>
        {lines.map((l, i) => (
          <p key={l} className={cn('truncate text-[13px] leading-[18px]', i === 0 ? 'font-medium text-text-secondary' : 'text-text-muted')}>
            {l}
          </p>
        ))}
      </div>
      <Link to={to} className="mt-auto flex items-center gap-1 px-2 text-body font-semibold text-brand-600 hover:underline">
        <span className="min-w-0 flex-1">{cta}</span>
        <span aria-hidden>→</span>
      </Link>
    </li>
  );
}
