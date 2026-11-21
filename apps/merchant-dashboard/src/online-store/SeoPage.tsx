import { isApiError } from '@storeplix/api-client';
import type { StoreSettings } from '@storeplix/types';
import { Badge, Button, DraftBar, DraftBarGhostButton, Toggle } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { settingsKey } from '../settings/schema';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';
import { ImageField, type PickedMedia } from './components/MediaPicker';
import { ErrorState, LoadingState, OnlineStoreHeader, Panel, ReadOnlyBanner } from './components/Shell';
import { toast } from './components/Toast';
import { FieldError, FieldLabel } from './editor/fields';
import { useCanEditStore, useStorePages } from './hooks';

// Figma V3 SEO settings 2044:48073 (Main 2044:48075) + "On Google" card from 2043:47848. Phase 3 builds the
// store-level subset (contract §3.4): home title + description with snippet preview and length hints (60/160),
// default share image, "Hide the whole shop from Google", sitemap row. Bottom bar Discard / Save → settings PATCH.

interface SeoForm {
  title: string;
  description: string;
  share: PickedMedia | null;
  hide: boolean;
}

function fromSettings(s: StoreSettings): SeoForm {
  return {
    title: s.seo?.title ?? '',
    description: s.seo?.description ?? '',
    share: s.seo?.share_image ? { id: s.seo.share_image.id, url: s.seo.share_image.url } : null,
    hide: s.seo?.hide_from_search ?? false,
  };
}

export function SeoPage() {
  const store = useTenantStore().data!;
  const settings = useQuery({ queryKey: settingsKey(store.id), queryFn: () => api.stores.getSettings(store.id) });
  if (settings.isPending) return <LoadingState label="Loading SEO settings" />;
  if (settings.isError) return <ErrorState onRetry={() => void settings.refetch()} />;
  return <SeoSettingsForm key={settings.data.updated_at} settings={settings.data} />;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function SeoSettingsForm({ settings }: { settings: StoreSettings }) {
  const canEdit = useCanEditStore();
  const store = useTenantStore().data!;
  const pages = useStorePages();
  const queryClient = useQueryClient();
  const initial = fromSettings(settings);
  const [form, setForm] = useState<SeoForm>(initial);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const domain = storeDomain(store);
  const shownTitle = form.title.trim() || store.name;

  const errors: Record<string, string | undefined> = {
    title: form.title.length > 70 ? 'Use at most 70 characters.' : CONTROL.test(form.title) ? 'Remove line breaks.' : serverErrors['seo.title'],
    description: form.description.length > 160 ? 'Use at most 160 characters.' : CONTROL.test(form.description) ? 'Remove line breaks.' : serverErrors['seo.description'],
  };
  const invalid = !!errors.title || !!errors.description;

  const save = useMutation({
    mutationFn: () =>
      api.stores.updateSettings(store.id, {
        seo: {
          title: form.title.trim() || null,
          description: form.description.trim() || null,
          share_image_media_id: form.share?.id ?? null,
          hide_from_search: form.hide,
        },
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(settingsKey(store.id), updated);
      toast('SEO settings saved.');
    },
    onError: (e) => {
      if (isApiError(e) && e.details) setServerErrors(Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k, v[0] ?? ''])));
      toast(isApiError(e) ? e.message : 'Couldn’t save. Try again.', 'error');
    },
  });

  const publishedPages = pages.data?.meta.counts.published ?? 0;
  const set = (patch: Partial<SeoForm>) => canEdit && setForm((f) => ({ ...f, ...patch }));
  const input =
    'w-full rounded-md border border-border-strong bg-surface-card px-3 py-[9px] text-body text-text-primary outline-none focus:border-brand-600 focus:shadow-focus disabled:bg-surface-subtle aria-invalid:border-danger';

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <OnlineStoreHeader title="SEO settings" description="How your shop shows up on Google and when it’s shared on Facebook or WhatsApp." />
      {!canEdit && <ReadOnlyBanner />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-5">
          <Panel title="Home page on Google" description="Leave empty to use your shop name.">
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="seo-title" label="Title" count={form.title.length} max={70} />
              <input id="seo-title" className={input} value={form.title} placeholder={store.name} disabled={!canEdit} aria-invalid={errors.title ? true : undefined} onChange={(e) => set({ title: e.target.value })} />
              {!errors.title && <p className="text-caption text-text-muted">{shownTitle.length <= 60 ? 'Fits ✓' : 'Google may cut titles longer than 60 letters.'}</p>}
              <FieldError id="seo-title-err" message={errors.title} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="seo-desc" label="Description" count={form.description.length} max={160} />
              <textarea id="seo-desc" rows={3} className={input} value={form.description} disabled={!canEdit} aria-invalid={errors.description ? true : undefined} onChange={(e) => set({ description: e.target.value })} />
              <FieldError id="seo-desc-err" message={errors.description} />
            </div>
          </Panel>

          <Panel title="When shared on Facebook & WhatsApp" description="The picture people see in the link preview.">
            <ImageField label="Default share image" hint="1200 × 630 · landscape" title="Choose a share image" disabled={!canEdit} value={form.share} onChange={(share) => set({ share })} />
            <p className="text-caption text-text-muted">Used when a page has no photo of its own · 1200 × 630</p>
          </Panel>

          <Panel title="Sitemap & indexing" description="How search engines find your pages.">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-medium text-text-primary">Sitemap</span>
                <span className="text-caption text-text-muted">Updates itself whenever you add or change a page</span>
              </div>
              <span className="text-caption text-text-secondary">{domain}/sitemap.xml</span>
              <Badge tone={form.hide || store.status !== 'active' ? 'neutral' : 'success'}>{form.hide || store.status !== 'active' ? 'Empty while hidden' : `${publishedPages + 1} pages`}</Badge>
            </div>
            <div className="flex items-center gap-3 border-t border-border-default pt-4">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-medium text-text-primary">Hide the whole shop from Google</span>
                <span className="text-caption text-text-muted">Only while you’re still setting up</span>
              </div>
              <Toggle label="Hide the whole shop from Google" checked={form.hide} disabled={!canEdit} onChange={(hide) => set({ hide })} />
            </div>
          </Panel>
        </div>

        <aside aria-label="Preview on Google" className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
          <span className="text-caption font-semibold text-text-primary">Preview · Home page</span>
          <div className="flex flex-col gap-1 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1">
            <span className="text-[10px] font-semibold tracking-wide text-text-muted uppercase">Google</span>
            <span className="truncate text-caption text-text-secondary">{domain}</span>
            <span className="text-body-lg text-info">{shownTitle.length > 60 ? `${shownTitle.slice(0, 57)}…` : shownTitle}</span>
            <span className="text-caption text-text-secondary">{form.description.trim() ? (form.description.length > 160 ? `${form.description.slice(0, 157)}…` : form.description) : 'Google will pick text from your home page.'}</span>
            {form.hide && <span className="pt-1 text-caption font-medium text-warning">Hidden from Google while this is on</span>}
          </div>
          <div className="overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">
            <div className="aspect-[1200/630] bg-surface-subtle">{form.share?.url && <img src={form.share.url} alt="" className="size-full object-cover" />}</div>
            <div className="flex flex-col gap-0.5 bg-surface-subtle px-3 py-2.5">
              <span className="text-[10px] font-semibold tracking-wide text-text-muted uppercase">Facebook · WhatsApp</span>
              <span className="text-body font-semibold text-text-primary">{shownTitle}</span>
            </div>
          </div>
        </aside>
      </div>

      {canEdit && dirty && (
        <DraftBar
          title="Unsaved changes"
          description="Buyers and Google see the old settings until you save"
          actions={
            <>
              <DraftBarGhostButton onClick={() => setForm(initial)}>Discard</DraftBarGhostButton>
              <Button loading={save.isPending} disabled={invalid} onClick={() => save.mutate()}>
                Save
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
