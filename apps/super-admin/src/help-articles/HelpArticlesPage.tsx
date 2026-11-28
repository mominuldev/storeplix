import type { AdminHelpArticleFilters, AdminHelpArticleSummary, AdminHelpArticleTab, HelpLanguage } from '@storeplix/types';
import { Badge, Button, Card, DataTable, Menu, Pagination, Tabs, cn, type DataTableColumn } from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { useCan } from '../lib/permissions';
import { useDebounced } from '../lib/useDebounced';
import { CategoriesDrawer } from './CategoriesDrawer';
import { articleStatusMeta, helpfulCell, shortDay, shortName } from './format';
import { NewArticleDialog } from './NewArticleDialog';
import { helpKeys, useHelpCategories } from './queries';

const TABS: AdminHelpArticleTab[] = ['all', 'published', 'draft', 'scheduled', 'archived', 'missing_bn'];
const TAB_LABEL: Record<AdminHelpArticleTab, string> = {
  all: 'All',
  published: 'Published',
  draft: 'Drafts',
  scheduled: 'Scheduled',
  archived: 'Archived',
  missing_bn: 'Missing বাংলা',
};
type Sort = NonNullable<AdminHelpArticleFilters['sort']>;
const SORT_LABEL: Record<Sort, string> = { updated: 'Recently updated', title: 'Title', helpful: 'Helpful rate', views: 'Most viewed' };

export function NoHelpAccess({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <Empty icon={<BookOpen />} title="You don’t have access to help articles" description="Ask a super admin for the “Help articles” permission (support and super admins have it)." />
      </Card>
    </>
  );
}

function FilterChip({ label, value, entries }: { label: string; value: string; entries: { key: string; label: string; onSelect: () => void }[] }) {
  return (
    <Menu
      label={label}
      align="start"
      triggerClassName="flex size-auto h-9 items-center whitespace-nowrap gap-1.5 rounded-full border border-border-default bg-surface-card px-3.5 text-body font-medium text-text-secondary outline-none hover:text-text-primary focus-visible:shadow-focus"
      trigger={
        <>
          {label}: {value}
          <ChevronDown aria-hidden className="size-3.5" />
        </>
      }
      entries={entries}
    />
  );
}

function LanguageTags({ languages }: { languages: AdminHelpArticleSummary['languages'] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge size="sm" tone={languages.en === 'missing' ? 'warning' : 'success'}>
        EN
      </Badge>
      {languages.bn === 'missing' ? (
        <Badge size="sm" tone="warning">
          বাংলা missing
        </Badge>
      ) : (
        <Badge size="sm" tone={languages.bn === 'published' ? 'success' : 'neutral'}>
          বাংলা{languages.bn === 'draft' ? ' draft' : ''}
        </Badge>
      )}
    </span>
  );
}

// Platform / Help articles 2134:10410 (PHASE-8-9C §14, `manage_help_content`): header + Categories / New article,
// stats, tabs with counts, search (≥ 2), chips Category / Language / Sort, table, pagination. Row → editor.
export function HelpArticlesPage({ startNew = false }: { startNew?: boolean }) {
  const can = useCan();
  const allowed = can('manage_help_content');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t === params.get('tab')) ?? 'all';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const category = params.get('category') ?? undefined;
  const language = (['en', 'bn'] as const).find((l) => l === params.get('language'));
  const sort = (Object.keys(SORT_LABEL) as Sort[]).find((s) => s === params.get('sort')) ?? 'updated';
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q.trim(), 300);
  const [dialog, setDialog] = useState<'new' | 'categories' | null>(startNew ? 'new' : null);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const value = debouncedQ.length >= 2 ? debouncedQ : '';
    if ((params.get('q') ?? '') !== value) update({ q: value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const filters: AdminHelpArticleFilters = { tab, q: params.get('q') ?? undefined, category, language, sort, page, per_page: 25 };
  const list = useQuery({
    queryKey: [...helpKeys.articles, 'list', filters],
    queryFn: () => api.admin.help.articles.list(filters),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const categories = useHelpCategories(allowed);

  if (!allowed) return <NoHelpAccess title="Help articles" />;

  const meta = list.data?.meta;
  const categoryName = categories.data?.find((c) => c.id === category)?.name_en ?? 'All';
  const languageLabel = (l: HelpLanguage | undefined) => (l === 'en' ? 'English' : l === 'bn' ? 'বাংলা' : 'Both');
  const filtered = !!(filters.q || category || language);

  const columns: DataTableColumn<AdminHelpArticleSummary>[] = [
    {
      key: 'title',
      header: 'Title',
      mobileLabel: false,
      cell: (a) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body font-medium text-text-primary">{a.title || 'Untitled'}</span>
          <span className="truncate text-caption text-text-muted">/help/articles/{a.slug}</span>
        </span>
      ),
    },
    { key: 'category', header: 'Category', width: 150, cell: (a) => <span className="text-body text-text-secondary">{a.category.name}</span> },
    { key: 'languages', header: 'Languages', width: 150, cell: (a) => <LanguageTags languages={a.languages} /> },
    {
      key: 'status',
      header: 'Status',
      width: 150,
      cell: (a) => {
        const s = articleStatusMeta(a.status, a.scheduled_at);
        return (
          <span className="flex flex-col items-start gap-1">
            <Badge size="sm" dot tone={s.tone}>
              {s.label}
            </Badge>
            {a.has_unpublished_changes && a.status === 'published' && <span className="text-caption text-warning">Unpublished changes</span>}
          </span>
        );
      },
    },
    {
      key: 'helpful',
      header: 'Helpful',
      width: 100,
      cell: (a) => {
        const h = helpfulCell(a.helpful);
        return <span className={cn('text-body', h.low ? 'text-warning' : 'text-text-secondary')}>{h.text}</span>;
      },
    },
    {
      key: 'updated',
      header: 'Updated',
      width: 140,
      cell: (a) => (
        <span className="flex items-center gap-2">
          <span className="flex-1 text-caption text-text-secondary">
            {shortDay(a.updated_at)}
            {a.updated_by ? ` · ${shortName(a.updated_by)}` : ''}
          </span>
          <ChevronRight aria-hidden className="size-5 text-text-muted" />
        </span>
      ),
    },
  ];

  const stats = meta?.stats;
  const statTile = (dot: string, label: string, value: string, hint: string) => (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border-default bg-surface-card p-5">
      <span className="flex items-center gap-2 text-body text-text-secondary">
        <span aria-hidden className={cn('size-2 rounded-full', dot)} />
        {label}
      </span>
      <span className="text-heading-24 text-text-primary">{value}</span>
      <span className="text-caption text-text-muted">{hint}</span>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Help articles"
        subtitle="Guides merchants see in Help & support. Every article has an English and a বাংলা version."
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog('categories')}>
              Categories
            </Button>
            <Button onClick={() => setDialog('new')}>New article</Button>
          </>
        }
      />
      <section aria-label="Help article stats" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {statTile('bg-success', 'Published', stats ? String(stats.published) : '—', categories.data ? `${categories.data.length} categories` : ' ')}
        {statTile('bg-text-muted', 'Drafts', stats ? String(stats.drafts) : '—', 'Not visible to merchants')}
        {statTile('bg-warning', 'Missing বাংলা', stats ? String(stats.missing_bn) : '—', 'Published in English only')}
        {statTile(
          'bg-brand-600',
          'Found helpful',
          stats?.helpful_percent_30d === null || stats?.helpful_percent_30d === undefined ? '—' : `${Math.round(stats.helpful_percent_30d)}%`,
          'Last 30 days',
        )}
      </section>
      <DataTable
        label="Help articles"
        columns={columns}
        rows={list.data?.data ?? []}
        getRowId={(a) => a.id}
        rowLabel={(a) => a.title || a.slug}
        onRowClick={(a) => void navigate(`/help-articles/${a.id}`)}
        toolbar={
          <div className="flex flex-col gap-3 px-5 pt-2 pb-4">
            <div className="flex flex-wrap items-center gap-3">
              <Tabs
                aria-label="Article status"
                value={tab}
                onChange={(v) => update({ tab: v === 'all' ? null : v })}
                className="min-w-0 flex-1 border-b-0"
                items={TABS.map((t) => ({ value: t, label: TAB_LABEL[t], count: meta?.counts[t] ?? null }))}
              />
              <label className="flex h-10 w-full items-center gap-2 rounded-md bg-surface-subtle px-3 focus-within:shadow-focus sm:w-72">
                <Search aria-hidden className="size-4 text-text-muted" />
                <input
                  type="search"
                  aria-label="Search title, slug or keyword"
                  placeholder="Search title, slug or keyword"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <FilterChip
                label="Category"
                value={categoryName}
                entries={[
                  { key: 'all', label: 'All categories', onSelect: () => update({ category: null }) },
                  ...(categories.data ?? []).map((c) => ({ key: c.id, label: c.name_en, onSelect: () => update({ category: c.id }) })),
                ]}
              />
              <FilterChip
                label="Language"
                value={languageLabel(language)}
                entries={[
                  { key: 'both', label: 'Both', onSelect: () => update({ language: null }) },
                  { key: 'en', label: 'Has English', onSelect: () => update({ language: 'en' }) },
                  { key: 'bn', label: 'Has বাংলা', onSelect: () => update({ language: 'bn' }) },
                ]}
              />
              <FilterChip
                label="Sort"
                value={SORT_LABEL[sort]}
                entries={(Object.keys(SORT_LABEL) as Sort[]).map((s) => ({ key: s, label: SORT_LABEL[s], onSelect: () => update({ sort: s === 'updated' ? null : s }) }))}
              />
            </div>
          </div>
        }
        state={
          list.isPending ? (
            <LoadingRows label="Loading help articles" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.data.length === 0 ? (
            <Empty
              icon={<BookOpen />}
              title={filtered ? 'No articles match these filters' : tab === 'all' ? 'No help articles yet' : `No ${TAB_LABEL[tab].toLowerCase()} articles`}
              description={filtered ? 'Try another search, category or language.' : tab === 'all' ? 'Write the first guide merchants will see in Help & support.' : 'Nothing in this tab yet.'}
              action={
                !filtered && tab === 'all' ? (
                  <Button variant="secondary" onClick={() => setDialog('new')}>
                    New article
                  </Button>
                ) : undefined
              }
            />
          ) : undefined
        }
        footer={
          meta && meta.total > 0 ? (
            <div className="flex flex-col gap-1">
              <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="articles" onPage={(p) => update({ page: p > 1 ? String(p) : null })} />
              <p className="px-5 pb-3 text-caption text-text-muted">Helpful rate under 70% shows in amber.</p>
            </div>
          ) : undefined
        }
      />
      {dialog === 'new' && (
        <NewArticleDialog
          onClose={() => {
            setDialog(null);
            if (startNew) void navigate('/help-articles', { replace: true });
          }}
          onCreated={(id) => void navigate(`/help-articles/${id}`)}
        />
      )}
      <CategoriesDrawer open={dialog === 'categories'} onClose={() => setDialog(null)} />
    </>
  );
}
