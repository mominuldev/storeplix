import { isApiError } from '@storeplix/api-client';
import type { NavigationHandle, PageBlock, PageStatus, RichTextDoc, StorePage } from '@storeplix/types';
import { Button, Checkbox, cn, Drawer, gripProps, Menu, SegmentedControl, SortableList, type MenuEntry } from '@storeplix/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, GripVertical, Lock, PanelLeft, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../../lib/api';
import { useTenantStore } from '../../stores/useTenantStore';
import { ImageField } from '../components/MediaPicker';
import { ConflictDialog, ErrorState, LoadingState, StatusBadge } from '../components/Shell';
import { toast } from '../components/Toast';
import { AutosaveController, type AutosaveStatus } from '../editor/autosave';
import type { Device } from '../editor/editorReducer';
import { FieldError, FieldLabel } from '../editor/fields';
import { PreviewFrame, type PreviewFrameHandle } from '../editor/PreviewFrame';
import { osKeys, useCanEditStore, useNavigationMenus, useStorePages } from '../hooks';
import { addPage, containsPage, removePage, toNavItems } from '../navigation/navState';
import { blockTitle, blockTypes, newBlock, pagePatch, slugError, validatePageBody } from './pageBlocks';

// Page editor: V3 editor shell 2045:48301 reused; block list and form per V1 Edit page 74:22532 (V3 has no
// page-body frame). Saves live (contract P3-6) with an 800 ms debounced PATCH + preview refresh.
// Out of scope: revision history, SEO score, scheduling, বাংলা/English tabs, template switch.

const RichTextEditor = lazy(() => import('../richtext/RichTextEditor'));
export const PAGE_AUTOSAVE_MS = 800;

const input =
  'w-full rounded-md border border-border-strong bg-surface-card px-3 py-[9px] text-[13px] leading-[19px] text-text-primary outline-none focus:border-brand-600 focus:shadow-focus disabled:bg-surface-subtle aria-invalid:border-danger';

export default function PageEditorPage() {
  const { pageId } = useParams();
  const store = useTenantStore().data!;
  const [generation, setGeneration] = useState(0);
  const page = useQuery({ queryKey: osKeys.page(store.id, pageId), queryFn: () => api.pages.get(store.id, pageId!), enabled: !!pageId, staleTime: 0 });
  if (page.isPending) return <LoadingState label="Opening the page" />;
  if (page.isError || !page.data)
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <ErrorState message={isApiError(page.error) && page.error.status === 404 ? 'This page doesn’t exist any more.' : undefined} onRetry={() => void page.refetch()} />
      </div>
    );
  return (
    <PageEditor
      key={`${page.data.id}:${generation}`}
      page={page.data}
      onReload={async () => {
        await page.refetch();
        setGeneration((g) => g + 1);
      }}
    />
  );
}

type Draft = Pick<StorePage, 'title' | 'slug' | 'status' | 'body' | 'seo'>;

function PageEditor({ page, onReload }: { page: StorePage; onReload: () => Promise<void> }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const store = useTenantStore().data!;
  const canEdit = useCanEditStore();
  const menus = useNavigationMenus();
  const pages = useStorePages();
  const [draft, setDraft] = useState<Draft>({ title: page.title, slug: page.slug, status: page.status, body: page.body, seo: page.seo });
  const [savedSlug, setSavedSlug] = useState(page.slug);
  const [open, setOpen] = useState<string | null>(page.body[0]?.id ?? null);
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [serverErrors, setServerErrors] = useState<Record<string, string[]>>({});
  const [conflict, setConflict] = useState(false);
  const [device, setDevice] = useState<Device>('desktop');
  const [drawer, setDrawer] = useState<'left' | 'right' | null>(null);
  const [media, setMedia] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(page.media ?? {}).map(([id, m]) => [id, m.url])));
  const previewRef = useRef<PreviewFrameHandle>(null);
  const first = useRef(true);

  const [controller] = useState(
    () =>
      new AutosaveController<Draft, StorePage>({
        delay: PAGE_AUTOSAVE_MS,
        baseRevision: page.revision,
        save: async (d, revision) => {
          const saved = await api.pages.update(store.id, page.id, { ...pagePatch(d, revision), status: d.status });
          return { revision: saved.revision, result: saved };
        },
      }),
  );
  // Callbacks touch refs/state, so they are (re)bound in an effect rather than during render.
  useEffect(() => {
    controller.setHandlers({
        onStatus: setStatus,
      onSaved: (saved) => {
        setServerErrors({});
        setSavedSlug(saved.slug);
        queryClient.setQueryData(osKeys.page(store.id, page.id), saved);
        void queryClient.invalidateQueries({ queryKey: osKeys.pages(store.id) });
        previewRef.current?.refresh();
      },
      onConflict: () => setConflict(true),
      onInvalid: (d) => setServerErrors(d),
      onError: () => toast('We couldn’t save your last change. We’ll retry with the next one.', 'error'),
    });
  });

  const clientErrors = useMemo(() => {
    const otherSlugs = (pages.data?.data ?? []).filter((p) => p.id !== page.id).map((p) => p.slug);
    const e: Record<string, string> = validatePageBody(draft.body);
    if (!draft.title.trim()) e.title = 'Give the page a name.';
    else if (draft.title.length > 120) e.title = 'Use at most 120 characters.';
    const se = slugError(draft.slug, otherSlugs);
    if (se) e.slug = se;
    if ((draft.seo.title?.length ?? 0) > 70) e['seo.title'] = 'Use at most 70 characters.';
    if ((draft.seo.description?.length ?? 0) > 160) e['seo.description'] = 'Use at most 160 characters.';
    return e;
  }, [draft, pages.data, page.id]);
  const err = (k: string) => clientErrors[k] ?? serverErrors[k]?.[0];
  const invalid = Object.keys(clientErrors).length > 0;

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (canEdit && !invalid) controller.schedule(draft);
  }, [draft, canEdit, invalid, controller]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!controller.busy) return;
      e.preventDefault();
      e.returnValue = 'Your latest change is still saving';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      void controller.flush();
    };
  }, [controller]);

  const update = (patch: Partial<Draft>) => canEdit && setDraft((d) => ({ ...d, ...patch }));
  const setBlock = (id: string, patch: Partial<PageBlock>) => update({ body: draft.body.map((b) => (b.id === id ? ({ ...b, ...patch } as PageBlock) : b)) });

  const back = async () => {
    await controller.flush();
    navigate('/online-store/pages');
  };

  // "Show in menu" edits the menus directly (each PUT carries the menu revision).
  const toggleMenu = async (handle: NavigationHandle, on: boolean) => {
    const menu = menus.data?.find((m) => m.handle === handle);
    if (!menu) return;
    const items = toNavItems(menu.items);
    const next = on ? addPage(items, page.id, draft.title) : removePage(items, page.id);
    try {
      await api.navigation.save(store.id, handle, { items: next, revision: menu.revision });
      await queryClient.invalidateQueries({ queryKey: osKeys.navigation(store.id) });
      void queryClient.invalidateQueries({ queryKey: osKeys.pages(store.id) });
      previewRef.current?.refresh();
    } catch (e) {
      await queryClient.invalidateQueries({ queryKey: osKeys.navigation(store.id) });
      toast(isApiError(e) && e.status === 409 ? 'That menu changed somewhere else. Try again.' : isApiError(e) ? e.message : 'Couldn’t update the menu.', 'error');
    }
  };

  const statusLabel = status === 'saving' || status === 'pending' ? 'Saving…' : status === 'error' ? 'Not saved' : invalid || status === 'invalid' ? 'Fix the highlighted fields to save' : status === 'saved' ? 'Saved' : '';

  const addEntries: MenuEntry[] = blockTypes.map((t) => ({
    key: t.type,
    label: t.label,
    hint: t.hint,
    disabled: draft.body.length >= 40,
    onSelect: () => {
      const block = newBlock(t.type, draft.body);
      update({ body: [...draft.body, block] });
      setOpen(block.id);
    },
  }));

  const left = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="page-title" label="Page title" count={draft.title.length} max={120} />
        <input id="page-title" className={input} value={draft.title} disabled={!canEdit} aria-invalid={err('title') ? true : undefined} onChange={(e) => update({ title: e.target.value })} />
        <FieldError id="page-title-err" message={err('title')} />
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="page-slug" label="Link" />
        <div className="flex items-center rounded-md border border-border-strong bg-surface-card pl-3 focus-within:border-brand-600">
          <span className="text-[13px] text-text-muted">/pages/</span>
          <input
            id="page-slug"
            className="min-w-0 flex-1 bg-transparent px-1 py-[9px] text-[13px] outline-none"
            value={draft.slug}
            maxLength={80}
            disabled={!canEdit}
            aria-invalid={err('slug') ? true : undefined}
            onChange={(e) => update({ slug: e.target.value.toLowerCase() })}
          />
        </div>
        <FieldError id="page-slug-err" message={err('slug')} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] leading-4 font-semibold tracking-[0.66px] text-text-muted uppercase">Blocks · {draft.body.length}/40</span>
        {canEdit && <Menu label="Add block" trigger={<Plus aria-hidden className="size-4" />} entries={addEntries} triggerClassName="size-7 bg-brand-50 text-brand-700" />}
      </div>
      {draft.body.length === 0 && <p className="text-caption text-text-muted">No blocks yet. Use + to add a heading, text or image.</p>}
      <SortableList
        label="Page blocks"
        items={draft.body}
        disabled={!canEdit}
        onMove={(from, to) => {
          const body = [...draft.body];
          const [b] = body.splice(from, 1);
          body.splice(to, 0, b!);
          update({ body });
        }}
        renderItem={(block, { handle, index }) => {
          const expanded = open === block.id;
          const hasError = Object.keys({ ...clientErrors, ...serverErrors }).some((k) => k.startsWith(`body.${index}.`) || k === `body.${index}`);
          return (
            <div className={cn('rounded-md border bg-surface-card', hasError ? 'border-danger' : 'border-border-default')}>
              <div className="flex items-center gap-1 px-1.5 py-1.5">
                {canEdit && (
                  <button type="button" aria-label={`Reorder ${blockTitle(block)}`} {...gripProps(handle)} className="flex size-6 cursor-grab touch-none items-center justify-center text-text-muted">
                    <GripVertical aria-hidden className="size-3.5" />
                  </button>
                )}
                <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : block.id)} className="flex min-w-0 flex-1 items-center gap-1 text-left text-[13px] font-medium text-text-primary">
                  <span className="truncate">{blockTitle(block)}</span>
                  <ChevronDown aria-hidden className={cn('ml-auto size-4 shrink-0 text-text-muted', expanded && 'rotate-180')} />
                </button>
                {canEdit && (
                  <button type="button" aria-label={`Remove ${blockTitle(block)}`} onClick={() => update({ body: draft.body.filter((b) => b.id !== block.id) })} className="flex size-6 items-center justify-center text-text-muted hover:text-danger">
                    <Trash2 aria-hidden className="size-3.5" />
                  </button>
                )}
              </div>
              {expanded && (
                <div className="flex flex-col gap-3 border-t border-border-default p-3">
                  <BlockForm block={block} index={index} set={(p) => setBlock(block.id, p)} err={err} disabled={!canEdit} media={media} onMedia={(id, url) => setMedia((m) => ({ ...m, [id]: url }))} />
                </div>
              )}
            </div>
          );
        }}
      />
    </div>
  );

  const right = (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-text-secondary">Visibility</span>
        <SegmentedControl<PageStatus>
          size="sm"
          aria-label="Visibility"
          disabled={!canEdit}
          value={draft.status}
          onChange={(status) => update({ status })}
          options={[
            { value: 'published', label: 'Published' },
            { value: 'draft', label: 'Draft' },
            { value: 'hidden', label: 'Hidden' },
          ]}
        />
        <p className="text-[11px] text-text-muted">
          {draft.status === 'published' ? 'Buyers can open this page.' : draft.status === 'draft' ? 'Only you can see it in preview.' : 'Hidden from buyers, links to it are hidden too.'}
        </p>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-1.5 text-caption font-medium text-text-secondary">Show in menu</legend>
        {(['main', 'footer', 'help'] as NavigationHandle[]).map((h) => {
          const menu = menus.data?.find((m) => m.handle === h);
          const checked = menu ? containsPage(toNavItems(menu.items), page.id) : false;
          return <Checkbox key={h} label={menu?.title ?? h} checked={checked} disabled={!canEdit || !menu} onChange={(e) => void toggleMenu(h, e.target.checked)} />;
        })}
      </fieldset>
      <div className="flex flex-col gap-3">
        <span className="text-[11px] leading-4 font-semibold tracking-[0.66px] text-text-muted uppercase">On Google</span>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="seo-title" label="SEO title" count={draft.seo.title?.length ?? 0} max={70} />
          <input id="seo-title" className={input} placeholder={draft.title} disabled={!canEdit} value={draft.seo.title ?? ''} aria-invalid={err('seo.title') ? true : undefined} onChange={(e) => update({ seo: { ...draft.seo, title: e.target.value || null } })} />
          <FieldError id="seo-title-err" message={err('seo.title')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="seo-desc" label="Description" count={draft.seo.description?.length ?? 0} max={160} />
          <textarea id="seo-desc" rows={3} className={input} disabled={!canEdit} value={draft.seo.description ?? ''} aria-invalid={err('seo.description') ? true : undefined} onChange={(e) => update({ seo: { ...draft.seo, description: e.target.value || null } })} />
          <FieldError id="seo-desc-err" message={err('seo.description')} />
        </div>
        <ImageField
          label="Share image"
          disabled={!canEdit}
          hint="1200 × 630 · landscape"
          value={draft.seo.share_image ? { id: draft.seo.share_image.id, url: draft.seo.share_image.url } : null}
          onChange={(m) => update({ seo: { ...draft.seo, share_image: m ? { id: m.id, url: m.url, width: 0, height: 0, status: 'ready' } : null } })}
        />
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh flex-col bg-surface-subtle">
      <header className="flex h-[60px] shrink-0 items-center gap-2 border-b border-border-default bg-surface-card pr-3 pl-2 sm:gap-3 sm:pr-4 sm:pl-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <button type="button" aria-label="Back to pages" onClick={() => void back()} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-surface-subtle">
            <ChevronLeft aria-hidden className="size-4" />
          </button>
          <div className="flex min-w-0 flex-col rounded-control border border-border-default py-1.5 pr-2 pl-2.5">
            <span className="text-[10px] leading-[13px] font-medium text-text-muted">Page</span>
            <span className="truncate text-[13px] leading-[18px] font-semibold text-text-primary">{draft.title || 'Untitled'}</span>
          </div>
          <StatusBadge status={draft.status} />
          <span role="status" aria-live="polite" className={cn('hidden truncate text-caption md:inline', invalid || status === 'error' ? 'text-danger' : 'text-text-muted')}>
            {canEdit ? statusLabel : ''}
          </span>
        </div>
        <SegmentedControl<Device>
          size="sm"
          aria-label="Preview device"
          className="hidden md:flex"
          value={device}
          onChange={setDevice}
          options={[
            { value: 'desktop', label: 'Desktop' },
            { value: 'tablet', label: 'Tablet' },
            { value: 'phone', label: 'Phone' },
          ]}
        />
        <div className="flex flex-1 items-center justify-end gap-2">
          <button type="button" aria-label="Blocks" onClick={() => setDrawer('left')} className="flex size-8 items-center justify-center rounded-md hover:bg-surface-subtle lg:hidden">
            <PanelLeft aria-hidden className="size-4" />
          </button>
          <button type="button" aria-label="Page settings" onClick={() => setDrawer('right')} className="flex size-8 items-center justify-center rounded-md hover:bg-surface-subtle lg:hidden">
            <SlidersHorizontal aria-hidden className="size-4" />
          </button>
          {canEdit ? (
            draft.status !== 'published' && (
              <Button disabled={invalid} onClick={() => update({ status: 'published' })}>
                Publish
              </Button>
            )
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-surface-subtle px-3 py-1.5 text-caption font-medium text-text-secondary">
              <Lock aria-hidden className="size-3.5" /> View only
            </span>
          )}
        </div>
      </header>
      {!canEdit && (
        <div role="note" className="flex items-center justify-center gap-2 border-b border-border-default bg-info-bg px-4 py-2 text-caption text-info">
          <Lock aria-hidden className="size-3.5" /> Ask a manager to make changes.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Page content" className="hidden w-80 shrink-0 overflow-y-auto border-r border-border-default bg-surface-card p-4 lg:block">
          {left}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col pt-3">
          <PreviewFrame ref={previewRef} path={`/pages/${savedSlug}`} device={device} label={`${draft.title} preview`} />
        </main>
        <aside aria-label="Page settings" className="hidden w-80 shrink-0 overflow-y-auto border-l border-border-default bg-surface-card p-5 lg:block">
          {right}
        </aside>
      </div>
      <Drawer open={drawer === 'left'} onClose={() => setDrawer(null)} title="Blocks" side="left">
        <div className="p-4">{left}</div>
      </Drawer>
      <Drawer open={drawer === 'right'} onClose={() => setDrawer(null)} title="Page settings" side="right">
        <div className="p-4">{right}</div>
      </Drawer>
      <ConflictDialog open={conflict} onReload={() => void onReload()} />
    </div>
  );
}

function BlockForm({
  block,
  index,
  set,
  err,
  disabled,
  media,
  onMedia,
}: {
  block: PageBlock;
  index: number;
  set: (patch: Partial<PageBlock>) => void;
  err: (key: string) => string | undefined;
  disabled: boolean;
  media: Record<string, string>;
  onMedia: (id: string, url: string) => void;
}) {
  const p = `body.${index}`;
  const text = (key: string, label: string, value: string | null, max: number, nullable = true, area = false) => {
    const id = `${p}.${key}`;
    const Tag = area ? 'textarea' : 'input';
    return (
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor={id} label={label} count={value?.length ?? 0} max={max} />
        <Tag id={id} className={input} disabled={disabled} value={value ?? ''} aria-invalid={err(id) ? true : undefined} onChange={(e) => set({ [key]: e.target.value === '' && nullable ? null : e.target.value } as Partial<PageBlock>)} />
        <FieldError id={`${id}-err`} message={err(id)} />
      </div>
    );
  };
  switch (block.type) {
    case 'heading':
      return (
        <>
          {text('text', 'Heading', block.text, 120, false)}
          <SegmentedControl
            size="sm"
            aria-label="Heading size"
            disabled={disabled}
            value={String(block.level)}
            onChange={(v) => set({ level: Number(v) as 2 | 3 })}
            options={[
              { value: '2', label: 'Large' },
              { value: '3', label: 'Small' },
            ]}
          />
        </>
      );
    case 'rich_text':
      return (
        <div className="flex flex-col gap-1.5">
          <Suspense fallback={<div className="h-28 animate-pulse rounded-md bg-surface-subtle" />}>
            <RichTextEditor label="Text" value={block.doc} disabled={disabled} onChange={(doc: RichTextDoc) => set({ doc })} />
          </Suspense>
          <FieldError id={`${p}.doc-err`} message={err(`${p}.doc`)} />
        </div>
      );
    case 'image':
      return (
        <>
          <ImageField
            label="Image"
            disabled={disabled}
            value={block.media_id ? { id: block.media_id, url: media[block.media_id] ?? '' } : null}
            onChange={(m) => {
              if (m) onMedia(m.id, m.url);
              set({ media_id: m?.id ?? null });
            }}
          />
          {text('alt', 'Description (alt text)', block.alt, 160)}
          {text('caption', 'Caption', block.caption, 200)}
        </>
      );
    case 'button':
      return (
        <>
          {text('label', 'Button text', block.label, 40, false)}
          {text('href', 'Goes to', block.href, 2048, false)}
          <p className="-mt-2 text-[11px] text-text-muted">A page (/pages/contact), https:// link, https://wa.me/880… or tel:</p>
          <SegmentedControl
            size="sm"
            aria-label="Button style"
            disabled={disabled}
            value={block.style}
            onChange={(style) => set({ style })}
            options={[
              { value: 'primary', label: 'Filled' },
              { value: 'secondary', label: 'Outline' },
            ]}
          />
        </>
      );
    case 'callout':
      return (
        <>
          {text('title', 'Title', block.title, 80)}
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${p}.items`} label="Lines (one per line, up to 8)" />
            <textarea
              id={`${p}.items`}
              rows={4}
              className={input}
              disabled={disabled}
              value={block.items.join('\n')}
              aria-invalid={err(`${p}.items`) ? true : undefined}
              onChange={(e) => set({ items: e.target.value.split('\n') })}
            />
            <FieldError id={`${p}.items-err`} message={err(`${p}.items`)} />
          </div>
          <SegmentedControl
            size="sm"
            aria-label="Tone"
            disabled={disabled}
            value={block.tone}
            onChange={(tone) => set({ tone })}
            options={[
              { value: 'info', label: 'Info' },
              { value: 'success', label: 'Good' },
              { value: 'warning', label: 'Warning' },
            ]}
          />
        </>
      );
    case 'table':
      return (
        <>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${p}.headers`} label="Columns (separate with |)" />
            <input
              id={`${p}.headers`}
              className={input}
              disabled={disabled}
              value={block.headers.join(' | ')}
              aria-invalid={err(`${p}.headers`) ? true : undefined}
              onChange={(e) => set({ headers: e.target.value.split('|').map((x) => x.trim()) })}
            />
            <FieldError id={`${p}.headers-err`} message={err(`${p}.headers`)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${p}.rows`} label="Rows (one per line, cells separated with |)" />
            <textarea
              id={`${p}.rows`}
              rows={5}
              className={input}
              disabled={disabled}
              value={block.rows.map((r) => r.join(' | ')).join('\n')}
              aria-invalid={err(`${p}.rows`) ? true : undefined}
              onChange={(e) => set({ rows: e.target.value.split('\n').map((line) => line.split('|').map((x) => x.trim())) })}
            />
            <FieldError id={`${p}.rows-err`} message={err(`${p}.rows`)} />
          </div>
        </>
      );
  }
}
