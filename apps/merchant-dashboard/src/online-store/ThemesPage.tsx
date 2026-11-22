import { isApiError } from '@storeplix/api-client';
import type { ThemeCatalogEntry } from '@storeplix/types';
import { Badge, Button, cn, Dialog, SegmentedControl } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { usePreviewStore } from '../stores/usePreviewStore';
import { useTenantStore } from '../stores/useTenantStore';
import { api } from '../lib/api';
import { ErrorState, LoadingState, OnlineStoreHeader, ReadOnlyBanner } from './components/Shell';
import { toast } from './components/Toast';
import { useActiveTheme, useCanEditStore, useClockLabel, useThemeCatalog } from './hooks';
import { formatTaka, styleSummary, themeThumbnail } from './themeAssets';
import { countChanges } from './editor/changes';

// Figma V3 Themes 2032:44891 (Main 2032:44893): current theme card + theme library (9 cards). Only themes with
// `status: available` and tier free can be applied (contract P3-2/P3-15); the rest show "Coming soon".
// Upload theme, Buy & apply and More actions are out of scope (not shown).

type Filter = 'all' | 'free' | 'premium';

export function ThemesPage() {
  const navigate = useNavigate();
  const canEdit = useCanEditStore();
  const store = useTenantStore().data;
  const catalog = useThemeCatalog();
  const { summary, theme, isPending, isError, list } = useActiveTheme();
  const preview = usePreviewStore();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [confirm, setConfirm] = useState<ThemeCatalogEntry | null>(null);
  const savedAt = useClockLabel(summary?.draft_updated_at);

  const apply = useMutation({
    mutationFn: (code: string) => api.storeThemes.apply(store!.id, code),
    onSuccess: async (applied) => {
      setConfirm(null);
      await queryClient.invalidateQueries({ queryKey: ['store-themes'] });
      await queryClient.invalidateQueries({ queryKey: ['store-theme'] });
      toast(`${applied.name} is now your theme.`);
    },
    onError: (e) => {
      setConfirm(null);
      toast(isApiError(e) && e.code === 'theme_unavailable' ? 'This theme isn’t available yet.' : 'We couldn’t switch themes. Try again.', 'error');
    },
  });

  if (catalog.isPending || isPending) return <LoadingState label="Loading themes" />;
  if (catalog.isError || isError) return <ErrorState onRetry={() => void Promise.all([catalog.refetch(), list.refetch(), theme.refetch()])} />;

  const all = catalog.data;
  const counts = { all: all.length, free: all.filter((t) => t.tier === 'free').length, premium: all.filter((t) => t.tier === 'premium').length };
  const shown = all.filter((t) => filter === 'all' || t.tier === filter);
  const current = all.find((t) => t.code === summary?.code);
  const draft = theme.data?.draft_config;
  const changes = draft ? countChanges(draft, theme.data?.published_config) : 0;
  const style = styleSummary(theme.data?.published_config ?? draft);
  const thumb = current ? themeThumbnail(current) : undefined;

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      <OnlineStoreHeader title="Themes" description="Choose how your shop looks. Switching keeps your products, pages, menus and order form." />
      {!canEdit && <ReadOnlyBanner />}

      {summary && (
        <section
          aria-label="Current theme"
          className="grid items-center gap-6 rounded-[20px] border border-border-default bg-surface-card p-4 shadow-elevation-1 md:grid-cols-[minmax(0,558fr)_minmax(0,456fr)] md:gap-9 md:pr-9"
        >
          <div className="flex items-center justify-center overflow-hidden rounded-[14px] bg-[linear-gradient(139.5deg,var(--color-brand-50)_0%,var(--color-brand-100)_71.4%)] p-4 md:p-7">
            {thumb && <img src={thumb} alt={`${summary.name} theme preview`} className="aspect-[502/301] w-full rounded-[11px] object-cover object-top shadow-elevation-1" />}
          </div>
          <div className="flex flex-col gap-3.5 px-1 pb-2 md:p-0">
            <div className="flex flex-wrap gap-2">
              <InfoPill tone={summary.published_at ? 'success' : 'neutral'}>{summary.published_at ? 'Live' : 'Not published yet'}</InfoPill>
              {changes > 0 && (
                <InfoPill tone="warning">
                  {changes} unpublished change{changes === 1 ? '' : 's'}
                </InfoPill>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] leading-4 font-semibold tracking-[0.88px] text-brand-600 uppercase">Current theme</span>
              <h2 className="text-[30px] leading-[38px] font-semibold tracking-[-0.6px] text-text-primary">{summary.name}</h2>
            </div>
            {(current?.description || summary.published_at) && (
              <p className="text-[14px] leading-[21px] text-text-secondary">
                {current?.description ? `${current.description}.` : ''}
                {summary.published_at ? ` Live since ${new Date(summary.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : ''}
              </p>
            )}
            {style && (
              <dl className="flex flex-col text-[13px] leading-[18px]">
                <div className="flex items-center gap-3 border-t border-border-default py-2.5">
                  <dt className="w-20 shrink-0 text-text-muted">Colours</dt>
                  <dd className="flex items-center gap-3 font-medium text-text-primary">
                    <span className="flex -space-x-1">
                      {style.colours.map((c, i) => (
                        <span key={i} className="size-[18px] rounded-full border-2 border-surface-card" style={{ backgroundColor: c }} />
                      ))}
                    </span>
                    {style.colourName}
                  </dd>
                </div>
                <div className="flex items-center gap-3 border-t border-border-default py-2.5">
                  <dt className="w-20 shrink-0 text-text-muted">Fonts</dt>
                  <dd className="font-medium text-text-primary">{style.fonts}</dd>
                </div>
                <div className="flex items-center gap-3 border-t border-border-default py-2.5">
                  <dt className="w-20 shrink-0 text-text-muted">Buttons</dt>
                  <dd className="font-medium text-text-primary">{style.corners}</dd>
                </div>
              </dl>
            )}
            <div className="flex flex-wrap gap-2.5 pt-1.5">
              <Button onClick={() => navigate('/online-store/editor?page=home')}>{canEdit ? 'Customise' : 'View editor'}</Button>
              <Button variant="secondary" loading={preview.isPending} onClick={() => store && preview.mutate(store.id)}>
                Preview
              </Button>
            </div>
            {savedAt && (
              <p className="text-caption text-text-muted">
                Draft saved {savedAt}
                {summary.draft_updated_by ? ` by ${summary.draft_updated_by.name}` : ''}
              </p>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="library-title" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <h2 id="library-title" className="text-[18px] leading-[26px] font-semibold tracking-[-0.09px] text-text-primary">
              Theme library
            </h2>
            <p className="text-[13px] leading-[18px] text-text-muted">{all.length} themes made for Bangladeshi shops. Preview first — nothing changes until you publish.</p>
          </div>
          <SegmentedControl<Filter>
            size="sm"
            aria-label="Filter themes"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${counts.all}` },
              { value: 'free', label: `Free ${counts.free}` },
              { value: 'premium', label: `Premium ${counts.premium}` },
            ]}
          />
        </div>
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((t) => (
            <li key={t.code}>
              <ThemeCard
                entry={t}
                isCurrent={t.code === summary?.code}
                canEdit={canEdit}
                onApply={() => setConfirm(t)}
                onCustomise={() => navigate('/online-store/editor?page=home')}
                onPreview={() => store && preview.mutate(store.id)}
              />
            </li>
          ))}
        </ul>
      </section>

      <Dialog
        open={!!confirm}
        title={`Switch to ${confirm?.name ?? ''}?`}
        description="Your products, pages, menus and colours stay. The new look goes live straight away."
        confirmLabel="Apply theme"
        loading={apply.isPending}
        onConfirm={() => confirm && apply.mutate(confirm.code)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function ThemeCard({
  entry,
  isCurrent,
  canEdit,
  onApply,
  onCustomise,
  onPreview,
}: {
  entry: ThemeCatalogEntry;
  isCurrent: boolean;
  canEdit: boolean;
  onApply: () => void;
  onCustomise: () => void;
  onPreview: () => void;
}) {
  const available = entry.status === 'available' && entry.tier === 'free';
  const thumb = themeThumbnail(entry);
  return (
    <article
      aria-label={`${entry.name} theme`}
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-card border bg-surface-card shadow-elevation-1',
        isCurrent ? 'border-brand-600 shadow-[0_0_0_0.5px_var(--color-brand-600),var(--shadow-elevation-1)]' : 'border-border-default',
      )}
    >
      <div className={cn('aspect-[352/236] bg-surface-subtle', !available && 'opacity-80')}>{thumb && <img src={thumb} alt="" loading="lazy" className="size-full object-cover" />}</div>
      <div className="flex flex-1 flex-col gap-3.5 border-t border-border-default px-[18px] py-4">
        <div className="flex flex-col gap-[3px]">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-[15px] leading-[22px] font-semibold text-text-primary">{entry.name}</h3>
            {isCurrent ? (
              <Badge tone="brand" dot>
                Current
              </Badge>
            ) : (
              <>
                {entry.is_new && <Badge className="bg-accent-100 text-text-primary">New</Badge>}
                {entry.status === 'coming_soon' ? (
                  <Badge>Coming soon</Badge>
                ) : entry.tier === 'premium' ? (
                  <Badge tone="warning">Premium{entry.price_amount ? ` · ${formatTaka(entry.price_amount)}` : ''}</Badge>
                ) : (
                  <Badge tone="success">Free</Badge>
                )}
              </>
            )}
          </div>
          <p className="truncate text-[13px] leading-[18px] text-text-muted">{entry.description}</p>
        </div>
        <div className="mt-auto flex gap-2">
          <Button size="sm" variant="secondary" className="flex-1" disabled={!isCurrent} title={isCurrent ? undefined : available ? 'Apply this theme to preview it' : 'Coming soon'} onClick={onPreview}>
            Preview
          </Button>
          {isCurrent ? (
            <Button size="sm" className="flex-1" onClick={onCustomise}>
              {canEdit ? 'Customise' : 'View'}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" className="flex-1" disabled={!available || !canEdit} title={!available ? 'Coming soon' : undefined} onClick={onApply}>
              {available ? 'Apply theme' : 'Coming soon'}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

/** Figma 2032:45714 status pill: 12/18 medium, 6 px dot, pl 8 pr 9 py 2. */
function InfoPill({ tone, children }: { tone: 'success' | 'warning' | 'neutral'; children: ReactNode }) {
  const tones = { success: 'bg-success-bg text-success', warning: 'bg-warning-bg text-warning', neutral: 'bg-surface-subtle text-text-secondary' } as const;
  return (
    <span className={cn('inline-flex items-center gap-[5px] rounded-full py-0.5 pr-[9px] pl-2 text-[12px] leading-[18px] font-medium', tones[tone])}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
