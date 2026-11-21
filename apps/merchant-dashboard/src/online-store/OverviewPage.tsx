import { Badge, Button } from '@storeplix/ui';
import { ArrowRight, ExternalLink, FileText, Menu as MenuIcon, Palette, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { usePreviewStore } from '../stores/usePreviewStore';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';
import { countChanges } from './editor/changes';
import { useActiveTheme, useNavigationMenus, useStorePages } from './hooks';
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
    <div className="flex flex-col gap-6 lg:gap-8">
      <OnlineStoreHeader title="Online store" description="Everything buyers see — your theme, pages, domain and how the shop behaves." />

      <section aria-label="Your shop" className="grid gap-6 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:p-7">
        <div className="flex flex-col justify-center gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={store.status === 'active' ? 'success' : 'neutral'} dot>
              {store.status === 'active' ? 'Live' : 'Coming soon'}
            </Badge>
            {summary && <Badge className="border border-border-default bg-surface-card">{summary.name} theme</Badge>}
          </div>
          <h2 className="text-heading-32 text-text-primary">{store.name}</h2>
          <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 self-start text-body-lg font-medium text-brand-600 hover:underline">
            {domain} <ExternalLink aria-hidden className="size-4" />
          </a>
          {changes > 0 && (
            <Link to="/online-store/editor?page=home" className="flex items-center gap-2 self-start rounded-lg bg-warning-bg px-3.5 py-2.5 text-body text-text-primary">
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
              {changes} theme change{changes === 1 ? ' is' : 's are'} waiting to go live
              <span className="ml-2 inline-flex items-center gap-1 font-medium text-warning">
                Review <ArrowRight aria-hidden className="size-3.5" />
              </span>
            </Link>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => navigate('/online-store/editor?page=home')}>Customise theme</Button>
            <Button variant="secondary" loading={preview.isPending} onClick={() => preview.mutate(store.id)}>
              Preview
            </Button>
          </div>
        </div>
        <div className="hidden overflow-hidden rounded-card bg-surface-subtle p-6 lg:block">
          {summary && <img src={themeThumbnail({ name: summary.name, code: summary.code })} alt="" className="w-full rounded-lg shadow-elevation-1" />}
        </div>
      </section>

      <section aria-labelledby="parts" className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 id="parts" className="text-heading text-text-primary">
            Your website, part by part
          </h2>
          <p className="text-body text-text-secondary">Each card shows how that part is doing and the next thing worth doing.</p>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <PartCard
            icon={<Palette />}
            title="Theme & brand style"
            badge={changes > 0 ? <Badge tone="warning" dot>Draft</Badge> : <Badge tone="success" dot>Published</Badge>}
            lines={[`${summary?.name ?? 'Theme'} · ${style?.colourName ?? ''}`, changes > 0 ? `${changes} change${changes === 1 ? '' : 's'} not published` : 'Everything is live']}
            to="/online-store/editor?page=home"
            cta="Open editor"
          />
          <PartCard
            icon={<FileText />}
            title="Pages"
            badge={<Badge tone="success" dot>{counts?.published ?? 0} live</Badge>}
            lines={[`${counts?.all ?? 0} pages · 1 built-in`, counts?.draft ? `${counts.draft} draft${counts.draft === 1 ? '' : 's'} waiting` : 'No drafts']}
            to="/online-store/pages"
            cta="Manage pages"
          />
          <PartCard
            icon={<MenuIcon />}
            title="Navigation"
            badge={<Badge tone="success" dot>Published</Badge>}
            lines={[`${main?.title ?? 'Main menu'} · ${linkCount('main')} links`, `Footer ${linkCount('footer')} · Help ${linkCount('help')}`]}
            to="/online-store/navigation"
            cta="Edit menus"
          />
          <PartCard icon={<Search />} title="SEO" lines={['Title, description and share image', 'Sitemap updates itself']} to="/online-store/seo" cta="Open SEO settings" />
        </ul>
      </section>
    </div>
  );
}

function PartCard({ icon, title, badge, lines, to, cta }: { icon: ReactNode; title: string; badge?: ReactNode; lines: string[]; to: string; cta: string }) {
  return (
    <li className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-1.5 pb-4 shadow-elevation-1">
      <div className="flex h-24 items-center justify-center rounded-lg bg-brand-50 text-brand-600 [&_svg]:size-8">{icon}</div>
      <div className="flex flex-col gap-1 px-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-body font-semibold text-text-primary">{title}</h3>
          {badge}
        </div>
        {lines.map((l) => (
          <p key={l} className="truncate text-caption text-text-secondary">
            {l}
          </p>
        ))}
      </div>
      <Link to={to} className="mx-2.5 mt-auto flex items-center justify-between text-body font-medium text-brand-600 hover:underline">
        {cta} <ArrowRight aria-hidden className="size-4" />
      </Link>
    </li>
  );
}
