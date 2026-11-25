import { isApiError } from '@storeplix/api-client';
import type { StoreSettings } from '@storeplix/types';
import { Button, cn, DraftBar, DraftBarGhostButton, Toggle } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { settingsKey } from '../settings/schema';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';
import { MediaPicker, type PickedMedia } from './components/MediaPicker';
import { ErrorState, LoadingState, OnlineStoreHeader, ReadOnlyBanner } from './components/Shell';
import { toast } from './components/Toast';
import { FieldError } from './editor/fields';
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
  const [picking, setPicking] = useState(false);
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
      if (isApiError(e) && e.fieldErrors) setServerErrors(Object.fromEntries(Object.entries(e.fieldErrors).map(([k, v]) => [k, v[0] ?? ''])));
      toast(isApiError(e) ? e.message : 'Couldn’t save. Try again.', 'error');
    },
  });

  const publishedPages = pages.data?.meta.counts.published ?? 0;
  const set = (patch: Partial<SeoForm>) => canEdit && setForm((f) => ({ ...f, ...patch }));
  const input =
    'w-full rounded-md border border-border-strong bg-surface-card px-2.5 py-2 text-[13px] leading-[18px] text-text-primary outline-none focus:border-brand-600 focus:shadow-focus disabled:bg-surface-subtle aria-invalid:border-danger';
  const titleFits = shownTitle.length <= 60;

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      <OnlineStoreHeader title="SEO settings" description="How your shop shows up on Google and when it’s shared on Facebook or WhatsApp." />
      {!canEdit && <ReadOnlyBanner />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,720px)_minmax(0,360px)] lg:justify-between">
        <div className="flex flex-col gap-7">
          <SeoGroup title="Home page on Google" description="Leave empty to use your shop name.">
            <div className="flex flex-col gap-2 px-5 py-3.5">
              <div className="flex items-start gap-2">
                <label htmlFor="seo-title" className="min-w-0 flex-1 text-[13px] leading-[18px] font-medium text-text-secondary">
                  Title
                </label>
                <span className={cn('text-[11px] leading-4 font-medium', errors.title ? 'text-danger' : titleFits ? 'text-success' : 'text-warning')}>
                  {form.title.length}/70{!errors.title && titleFits ? ' · Fits ✓' : ''}
                </span>
              </div>
              <input id="seo-title" className={input} value={form.title} placeholder={store.name} disabled={!canEdit} aria-invalid={errors.title ? true : undefined} onChange={(e) => set({ title: e.target.value })} />
              {!errors.title && !titleFits && <p className="text-caption text-warning">Google may cut titles longer than 60 letters.</p>}
              <FieldError id="seo-title-err" message={errors.title} />
            </div>
            <div className="flex flex-col gap-2 border-t border-border-default px-5 py-3.5">
              <div className="flex items-start gap-2">
                <label htmlFor="seo-desc" className="min-w-0 flex-1 text-[13px] leading-[18px] font-medium text-text-secondary">
                  Description
                </label>
                <span className={cn('text-[11px] leading-4 font-medium', errors.description ? 'text-danger' : 'text-text-muted')}>{form.description.length}/160</span>
              </div>
              <textarea id="seo-desc" rows={3} className={input} value={form.description} disabled={!canEdit} aria-invalid={errors.description ? true : undefined} onChange={(e) => set({ description: e.target.value })} />
              <FieldError id="seo-desc-err" message={errors.description} />
            </div>
          </SeoGroup>

          <SeoGroup title="When shared on Facebook & WhatsApp" description="The picture and words people see in the link preview.">
            <SeoRow title="Default share image" description="Used when a page has no photo of its own · 1200 × 630">
              {form.share?.url && <img src={form.share.url} alt="" className="h-9 w-[68px] shrink-0 rounded-sm object-cover" />}
              {canEdit && (
                <>
                  {form.share && (
                    <Button size="sm" variant="ghost" onClick={() => set({ share: null })}>
                      Remove
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
                    {form.share ? 'Replace' : 'Choose'}
                  </Button>
                </>
              )}
            </SeoRow>
          </SeoGroup>

          <SeoGroup title="Sitemap & indexing" description="How search engines find your pages.">
            <SeoRow title="Sitemap" description="Updates itself whenever you add or change a page">
              <span className="flex flex-wrap items-center justify-end gap-2">
                <span className="text-caption font-medium text-text-secondary">{domain}/sitemap.xml</span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium',
                    form.hide || store.status !== 'active' ? 'bg-surface-subtle text-text-secondary' : 'bg-success-bg text-success',
                  )}
                >
                  {form.hide || store.status !== 'active' ? 'Empty while hidden' : `${publishedPages + 1} pages`}
                </span>
              </span>
            </SeoRow>
            <SeoRow title="Hide the whole shop from Google" description="Only while you’re still setting up">
              <Toggle label="Hide the whole shop from Google" checked={form.hide} disabled={!canEdit} onChange={(hide) => set({ hide })} />
            </SeoRow>
          </SeoGroup>
        </div>

        <aside aria-label="Preview on Google" className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
          <span className="text-[13px] leading-[18px] font-semibold text-text-primary">Preview · Home page</span>
          <div className="flex flex-col gap-1.5 rounded-[14px] border border-border-default bg-surface-card px-[18px] py-4">
            <span className="text-[10px] leading-[14px] font-semibold tracking-[0.8px] text-text-muted uppercase">Google</span>
            <span className="truncate text-[11px] leading-4 text-text-muted">{domain}</span>
            <span className="text-body-lg leading-[22px] text-info">{shownTitle.length > 60 ? `${shownTitle.slice(0, 57)}…` : shownTitle}</span>
            <span className="text-caption leading-[18px] text-text-secondary">
              {form.description.trim() ? (form.description.length > 160 ? `${form.description.slice(0, 157)}…` : form.description) : 'Google will pick text from your home page.'}
            </span>
            {form.hide && <span className="pt-1 text-caption font-medium text-warning">Hidden from Google while this is on</span>}
          </div>
          <div className="overflow-hidden rounded-[14px] border border-border-default bg-surface-card">
            <div className="h-[170px] bg-surface-subtle">{form.share?.url && <img src={form.share.url} alt="" className="size-full object-cover" />}</div>
            <div className="flex flex-col gap-0.5 bg-surface-subtle px-3.5 pt-2.5 pb-3">
              <span className="text-[10px] leading-[14px] font-semibold tracking-[0.8px] text-text-muted uppercase">Facebook · WhatsApp</span>
              <span className="text-[11px] leading-4 text-text-muted uppercase">{domain}</span>
              <span className="text-body font-semibold text-text-primary">{shownTitle}</span>
            </div>
          </div>
        </aside>
      </div>
      {picking && (
        <MediaPicker
          open
          title="Choose a share image"
          hint="1200 × 630 · landscape"
          currentId={form.share?.id}
          onClose={() => setPicking(false)}
          onPick={(share) => set({ share })}
        />
      )}

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

/** Figma 2044:48845 group: 16/24 heading + 13/18 muted line above a 14 px-radius card of divided rows. */
function SeoGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-body-lg font-semibold tracking-[-0.08px] text-text-primary">{title}</h2>
        <p className="text-[13px] leading-[18px] text-text-muted">{description}</p>
      </div>
      <div className="flex flex-col rounded-[14px] border border-border-default bg-surface-card shadow-elevation-1">{children}</div>
    </section>
  );
}

function SeoRow({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-5 px-5 py-3.5 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border-default">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="text-body font-medium text-text-primary">{title}</span>
        <span className="text-caption leading-[17px] text-text-muted">{description}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
