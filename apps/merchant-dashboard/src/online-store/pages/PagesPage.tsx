import { isApiError } from '@storeplix/api-client';
import type { NavigationHandle, PageStatus, PageTemplateCode, StorePageSummary } from '@storeplix/types';
import { Button, cn, Dialog, Menu, type MenuEntry } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, FileText, Lock, MoreHorizontal, Plus, Search, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../lib/api';
import { useTenantStore } from '../../stores/useTenantStore';
import { ErrorState, LoadingState, OnlineStoreHeader, ReadOnlyBanner, StatusBadge, TagPill } from '../components/Shell';
import { toast } from '../components/Toast';
import { embedUrl, osKeys, relativeTime, useCanEditStore, useStorePages } from '../hooks';
import { NewPageDialog } from './NewPageDialog';

// Figma V3 Pages 2036:46279 (Main 2036:46281): search, All/Yours/Hidden chips, template suggestions,
// "Your pages" table and "Built-in shop pages" (Home only until Phase 5).

type Chip = 'all' | 'yours' | 'hidden';
const menuLabel: Record<NavigationHandle, string> = { main: 'In main menu', footer: 'In footer', help: 'In help menu' };
const quickTemplates: { code: PageTemplateCode; label: string }[] = [
  { code: 'faq', label: 'FAQ' },
  { code: 'size_guide', label: 'Size guide' },
  { code: 'how_to_order', label: 'How to order' },
  { code: 'wholesale', label: 'Wholesale' },
];

export function PagesPage() {
  const navigate = useNavigate();
  const canEdit = useCanEditStore();
  const store = useTenantStore().data!;
  const pages = useStorePages();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [creating, setCreating] = useState<PageTemplateCode | 'pick' | null>(null);
  const [deleting, setDeleting] = useState<StorePageSummary | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: osKeys.pages(store.id) });

  const setStatus = useMutation({
    mutationFn: ({ page, status }: { page: StorePageSummary; status: PageStatus }) => api.pages.update(store.id, page.id, { revision: page.revision, status }),
    onSuccess: (p) => {
      void invalidate();
      toast(p.status === 'published' ? `${p.title} is live.` : p.status === 'hidden' ? `${p.title} is hidden.` : `${p.title} is back to draft.`);
    },
    onError: (e) => {
      void invalidate();
      toast(isApiError(e) && e.status === 409 ? 'This page changed somewhere else. We reloaded it — try again.' : 'Couldn’t update the page. Try again.', 'error');
    },
  });

  const remove = useMutation({
    mutationFn: (page: StorePageSummary) => api.pages.delete(store.id, page.id),
    onSuccess: () => {
      setDeleting(null);
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: osKeys.navigation(store.id) });
      toast('Page deleted.');
    },
    onError: () => toast('Couldn’t delete the page. Try again.', 'error'),
  });

  const preview = async (path: string) => {
    const tab = window.open('about:blank', '_blank');
    try {
      const t = await api.stores.createPreviewToken(store.id);
      if (tab) {
        tab.opener = null;
        tab.location.href = embedUrl(t.url, path, false);
      }
    } catch {
      tab?.close();
      toast('Couldn’t open the preview. Try again.', 'error');
    }
  };

  if (pages.isPending) return <LoadingState label="Loading pages" />;
  if (pages.isError) return <ErrorState onRetry={() => void pages.refetch()} />;

  const { data, meta } = pages.data;
  const query = q.trim().toLowerCase();
  const matches = (p: { title: string; slug: string }) => !query || p.title.toLowerCase().includes(query) || p.slug.includes(query);
  const yours = data.filter((p) => (chip === 'hidden' ? p.status === 'hidden' : true)).filter(matches);
  const showBuiltIn = chip === 'all' && matches({ title: 'Home', slug: '' });
  const atLimit = meta.counts.all >= meta.limit;

  const chips: { value: Chip; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: meta.counts.all + 1 },
    { value: 'yours', label: 'Yours', count: meta.counts.all },
    { value: 'hidden', label: 'Hidden', count: meta.counts.hidden },
  ];

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      <OnlineStoreHeader
        title="Pages"
        description="Your own pages, plus the built-in shop pages every theme needs."
        actions={
          canEdit && (
            <Button disabled={atLimit} title={atLimit ? `You can have up to ${meta.limit} pages.` : undefined} onClick={() => setCreating('pick')}>
              New page
            </Button>
          )
        }
      />
      {!canEdit && <ReadOnlyBanner />}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="flex h-[38px] items-center gap-2 rounded-control border border-border-strong bg-surface-card px-3 focus-within:border-brand-600 focus-within:shadow-focus sm:w-80">
          <Search aria-hidden className="size-4 text-text-muted" />
          <span className="sr-only">Find a page</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={80} placeholder="Find a page by name or link" className="w-full bg-transparent text-body outline-none placeholder:text-text-muted" />
        </label>
        <div role="group" aria-label="Filter pages" className="flex gap-0.5 self-start rounded-control bg-surface-subtle p-[3px] sm:self-auto">
          {chips.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={chip === c.value}
              onClick={() => setChip(c.value)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] leading-[18px] outline-none focus-visible:shadow-focus',
                chip === c.value ? 'bg-surface-card font-semibold text-text-primary shadow-elevation-1' : 'font-medium text-text-secondary',
              )}
            >
              {c.label} <span className="text-caption leading-[18px] font-medium text-text-muted">{c.count}</span>
            </button>
          ))}
        </div>
      </div>

      {canEdit && (
        <section aria-label="Suggested pages" className="flex flex-col gap-2.5 rounded-[14px] border border-brand-100 bg-gradient-to-r from-brand-50 to-surface-card py-3.5 pr-4 pl-5 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="text-body font-semibold text-text-primary">Missing a page buyers look for?</h2>
            <p className="text-caption text-text-muted">Ready-made, written for Bangladeshi shops — edit the words and publish.</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {quickTemplates.map((t) => (
              <button
                key={t.code}
                type="button"
                disabled={atLimit}
                onClick={() => setCreating(t.code)}
                className="flex items-center gap-1.5 rounded-full border border-border-default bg-surface-card py-1.5 pr-3 pl-2.5 text-[13px] leading-[18px] font-medium text-text-primary outline-none hover:border-brand-500 focus-visible:shadow-focus disabled:opacity-50"
              >
                <Plus aria-hidden className="size-3.5 text-brand-600" /> {t.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {chip !== 'all' || yours.length > 0 || data.length === 0 ? (
        <section aria-labelledby="your-pages" className="flex flex-col gap-2.5">
          <h2 id="your-pages" className="text-[15px] leading-[22px] font-semibold tracking-[-0.045px] text-text-primary">
            Your pages <span className="ml-1 text-[13px] leading-[18px] font-normal tracking-normal text-text-muted">{meta.counts.all} pages · you can add, hide or delete these</span>
          </h2>
          {yours.length === 0 ? (
            <p className="rounded-card border border-border-default bg-surface-card px-5 py-8 text-center text-body text-text-secondary">{q ? 'No pages match your search.' : chip === 'hidden' ? 'No hidden pages.' : 'No pages yet.'}</p>
          ) : (
            <ul className="divide-y divide-border-default overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">
              {yours.map((p) => {
                const entries: MenuEntry[] = [
                  ...(p.status !== 'published' ? [{ key: 'pub', label: 'Publish', icon: <Send />, onSelect: () => setStatus.mutate({ page: p, status: 'published' }) }] : []),
                  ...(p.status === 'published' ? [{ key: 'unpub', label: 'Unpublish', hint: 'Back to draft', icon: <FileText />, onSelect: () => setStatus.mutate({ page: p, status: 'draft' }) }] : []),
                  ...(p.status !== 'hidden' ? [{ key: 'hide', label: 'Hide', hint: 'Not shown in your shop', icon: <EyeOff />, onSelect: () => setStatus.mutate({ page: p, status: 'hidden' }) }] : []),
                  { kind: 'separator', key: 's' },
                  { key: 'del', label: 'Delete page', icon: <Trash2 />, danger: true, onSelect: () => setDeleting(p) },
                ];
                return (
                  <PageRow
                    key={p.id}
                    title={p.title}
                    path={p.url_path}
                    badges={p.in_menus.map((h) => menuLabel[h])}
                    edited={`Edited ${relativeTime(p.updated_at)}${p.updated_by ? ` · ${p.updated_by.name}` : ''}`}
                    status={<StatusBadge status={p.status} />}
                    onPreview={() => void preview(p.url_path)}
                    onEdit={() => navigate(`/online-store/pages/${p.id}`)}
                    editLabel={canEdit ? 'Edit' : 'View'}
                    menu={canEdit ? <Menu label={`${p.title} actions`} trigger={<MoreHorizontal aria-hidden className="size-4" />} entries={entries} triggerClassName="size-8" /> : null}
                  />
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {showBuiltIn && (
        <section aria-labelledby="builtin" className="flex flex-col gap-2.5">
          <h2 id="builtin" className="text-[15px] leading-[22px] font-semibold tracking-[-0.045px] text-text-primary">
            Built-in shop pages <span className="ml-1 text-[13px] leading-[18px] font-normal tracking-normal text-text-muted">your theme needs these, so they can be edited but not deleted</span>
          </h2>
          <ul className="overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">
            <PageRow
              title="Home"
              locked
              thumb="home"
              path="/"
              status={<StatusBadge status="published" />}
              onPreview={() => void preview('/')}
              onEdit={() => navigate('/online-store/editor?page=home')}
              editLabel={canEdit ? 'Edit' : 'View'}
            />
          </ul>
        </section>
      )}

      {creating && (
        <NewPageDialog
          initialTemplate={creating === 'pick' ? 'faq' : creating}
          onClose={() => setCreating(null)}
          onCreated={(page) => {
            setCreating(null);
            void invalidate();
            navigate(`/online-store/pages/${page.id}`);
          }}
        />
      )}
      <Dialog
        open={!!deleting}
        tone="danger"
        title={`Delete “${deleting?.title ?? ''}”?`}
        description="Menu links to this page stay but are hidden from buyers until you fix them."
        confirmLabel="Delete page"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

/** Figma 2036:47010 page thumbnail: 56×40 brand-50 card with a tiny page sketch. */
function PageThumb({ kind }: { kind: 'text' | 'home' }) {
  return (
    <span aria-hidden className="relative h-10 w-14 shrink-0 overflow-hidden rounded-sm border border-brand-100 bg-brand-50">
      <span className="absolute top-1 left-[5px] h-[3px] w-3.5 rounded-[1.5px] bg-brand-600" />
      <span className="absolute top-1 left-[35px] h-[3px] w-3.5 rounded-[1.5px] bg-brand-100" />
      {kind === 'text' ? (
        <>
          <span className="absolute top-[11px] left-[5px] h-[3px] w-[30px] rounded-[1.5px] bg-text-muted" />
          {[17, 22, 27, 32].map((top, i) => (
            <span key={top} className="absolute left-[5px] h-0.5 rounded-[1.5px] bg-brand-100" style={{ top, width: [44, 40, 44, 26][i] }} />
          ))}
        </>
      ) : (
        <>
          <span className="absolute top-[11px] left-[5px] h-3 w-11 rounded-[2px] bg-brand-100" />
          <span className="absolute top-[27px] left-[5px] h-1.5 w-11 rounded-[1.5px] bg-surface-card" />
        </>
      )}
    </span>
  );
}

function PageRow({
  title,
  path,
  badges = [],
  edited,
  status,
  onPreview,
  onEdit,
  editLabel,
  menu,
  locked,
  thumb = 'text',
}: {
  title: string;
  path: string;
  badges?: string[];
  edited?: string;
  status: React.ReactNode;
  onPreview: () => void;
  onEdit: () => void;
  editLabel: string;
  menu?: React.ReactNode;
  locked?: boolean;
  thumb?: 'text' | 'home';
}) {
  return (
    <li className="flex flex-wrap items-center gap-3.5 py-3 pr-3 pl-4 sm:flex-nowrap">
      <PageThumb kind={thumb} />
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-body font-medium text-text-primary">{title}</span>
          {locked && <Lock aria-label="Built-in" className="size-[13px] text-text-muted" />}
          {badges.map((b) => (
            <TagPill key={b}>{b}</TagPill>
          ))}
        </div>
        <span className="truncate text-caption text-text-muted">{path}</span>
      </div>
      <div className="ml-auto flex w-full items-center justify-end gap-3.5 sm:w-auto">
        <span className="hidden w-[150px] shrink-0 truncate text-caption text-text-muted md:block">{edited}</span>
        <span className="flex w-24 shrink-0">{status}</span>
        <span className="flex items-center gap-1">
          <button type="button" aria-label={`Preview ${title}`} onClick={onPreview} className="flex size-8 items-center justify-center rounded-md text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus">
            <Eye aria-hidden className="size-4" />
          </button>
          <Button size="sm" variant="secondary" onClick={onEdit} aria-label={`${editLabel} ${title}`}>
            {editLabel}
          </Button>
          <span className="flex w-8 justify-center">{menu}</span>
        </span>
      </div>
    </li>
  );
}
