import { isApiError } from '@storeplix/api-client';
import {
  HELP_FEEDBACK_REASON_LABELS,
  HELP_LANGUAGE_LABELS,
  HELP_LIMITS,
  HELP_SLUG_PATTERN,
  type AdminHelpArticle,
  type HelpArticleIncompleteDetails,
  type HelpLanguage,
  type HelpMediaRef,
  type HelpTranslationInput,
} from '@storeplix/types';
import { Badge, Button, Card, Dialog, Input, Modal, Select, Tabs, TagInput, cn } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate, formatDateTime } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';
import { HelpArticleBody } from './articleBody';
import { ArticleBodyField } from './ArticleBodyField';
import { docMediaIds, docProblems, emptyHelpDoc, missingFields, wordStats } from './doc';
import { FeedbackDrawer } from './FeedbackDrawer';
import { ago, articleStatusMeta, dhakaLocalToIso, isoToDhakaLocal } from './format';
import { NoHelpAccess } from './HelpArticlesPage';
import { helpKeys, useHelpCategories } from './queries';
import { RelatedArticlesCard, type RelatedRef } from './RelatedArticlesCard';

const AUTOSAVE_MS = 2000;

interface Draft {
  slug: string;
  category_id: string;
  related_article_ids: string[];
  en: HelpTranslationInput;
  bn: HelpTranslationInput | null;
}

const translationOf = (t: AdminHelpArticle['translations']['en'] | null): HelpTranslationInput | null =>
  t ? { title: t.title, summary: t.summary, body: t.body ?? emptyHelpDoc(), keywords: t.keywords ?? [] } : null;

function draftOf(a: AdminHelpArticle): Draft {
  return {
    slug: a.slug,
    category_id: a.category_id,
    related_article_ids: a.related_article_ids,
    en: translationOf(a.translations.en)!,
    bn: translationOf(a.translations.bn),
  };
}


const emptyTranslation = (): HelpTranslationInput => ({ title: '', summary: '', body: emptyHelpDoc(), keywords: [] });

function minScheduleLocal(): string {
  return isoToDhakaLocal(new Date(Date.now() + 6 * 60_000).toISOString());
}

// Platform / Help article editor 2134:66712 (PHASE-8-9C §14). Edits only the draft fields; merchants keep reading the
// published snapshot until Publish (P89C-4). Autosaves 2 s after the last change; a 409 revision conflict asks to reload.
export function HelpArticleEditorPage() {
  const can = useCan();
  const allowed = can('manage_help_content');
  const { id = '' } = useParams();
  const article = useQuery({ queryKey: helpKeys.article(id), queryFn: () => api.admin.help.articles.get(id), enabled: allowed && !!id });

  if (!allowed) return <NoHelpAccess title="Edit article" />;
  if (article.isPending)
    return (
      <Card>
        <LoadingRows label="Loading article" rows={8} />
      </Card>
    );
  if (article.isError) {
    const gone = isApiError(article.error) && article.error.status === 404;
    return (
      <Card>
        {gone ? (
          <Empty title="This article doesn’t exist" description="It may have been deleted. Go back to Help articles." action={<Link className="text-body font-medium text-brand-600" to="/help-articles">Help articles</Link>} />
        ) : (
          <ErrorState error={article.error} onRetry={() => void article.refetch()} />
        )}
      </Card>
    );
  }
  return <Editor key={article.data.id} initial={article.data} />;
}

function Editor({ initial }: { initial: AdminHelpArticle }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const id = initial.id;
  const { data: article = initial, refetch } = useQuery({ queryKey: helpKeys.article(id), queryFn: () => api.admin.help.articles.get(id), initialData: initial });
  const categories = useHelpCategories();

  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(draftOf(initial)));
  const revision = useRef(initial.revision);
  const [lang, setLang] = useState<HelpLanguage>('en');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [localMedia, setLocalMedia] = useState<Record<string, HelpMediaRef>>({});
  const [related, setRelated] = useState<Record<string, RelatedRef>>(() => Object.fromEntries(initial.related.map((r) => [r.id, r])));
  const [confirm, setConfirm] = useState<'unpublish' | 'archive' | 'delete' | 'remove_bn' | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [preview, setPreview] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [publishError, setPublishError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const dirty = JSON.stringify(draft) !== savedJson;
  const problems = useMemo(() => [...docProblems(draft.en.body), ...(draft.bn ? docProblems(draft.bn.body) : [])], [draft]);
  const slugInvalid = !HELP_SLUG_PATTERN.test(draft.slug) || draft.slug.length > HELP_LIMITS.slug;
  const media = useMemo(() => {
    const out: Record<string, HelpMediaRef> = { ...localMedia };
    for (const [k, v] of Object.entries(article.media)) if (!out[k] || v.status !== 'processing') out[k] = v;
    return out;
  }, [article.media, localMedia]);

  // "2 min ago" keeps moving.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Refresh processing images (status processing → ready comes from the media job).
  const processing = Object.values(media).some((m) => m.status === 'processing');
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => void refetch(), 5000);
    return () => clearInterval(t);
  }, [processing, refetch]);

  const accept = useCallback(
    (a: AdminHelpArticle) => {
      revision.current = a.revision;
      queryClient.setQueryData(helpKeys.article(id), a);
      void queryClient.invalidateQueries({ queryKey: helpKeys.articles, exact: false, refetchType: 'none' });
    },
    [id, queryClient],
  );

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const translations: { en: HelpTranslationInput; bn?: HelpTranslationInput | null } = { en: d.en };
      if (d.bn) translations.bn = d.bn;
      else if (article.translations.bn) translations.bn = null;
      const a = await api.admin.help.articles.update(id, { revision: revision.current, slug: d.slug, category_id: d.category_id, related_article_ids: d.related_article_ids, translations });
      return { a, sent: JSON.stringify(d) };
    },
    onSuccess: ({ a, sent }) => {
      setSavedJson(sent);
      accept(a);
      setLastSavedAt(new Date().toISOString());
      setSaveError(null);
      setSlugError(null);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'revision_conflict') setConflict(true);
      else if (isApiError(e) && e.code === 'help_slug_taken') setSlugError(errorMessage(e));
      else setSaveError(errorMessage(e, 'Couldn’t save the draft. We’ll keep trying while you edit.'));
    },
  });

  const canSave = dirty && !problems.length && !slugInvalid && !conflict && !!draft.category_id;
  // Autosave, debounced 2 s after the last change.
  useEffect(() => {
    if (!canSave || save.isPending) return;
    const t = setTimeout(() => save.mutate(draft), AUTOSAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, canSave, save.isPending]);

  /** Saves pending edits first so publishing never skips what is on screen. */
  const flush = async () => {
    if (!dirty) return;
    if (problems.length || slugInvalid) throw new Error(problems[0] ?? 'Fix the slug first.');
    await save.mutateAsync(draft);
  };

  const onActionError = (e: unknown) => {
    if (isApiError(e) && e.code === 'revision_conflict') return setConflict(true);
    if (isApiError(e) && e.code === 'help_article_incomplete') {
      const d = e.details as unknown as HelpArticleIncompleteDetails | undefined;
      if (d?.language) {
        setLang(d.language);
        return setPublishError(`${HELP_LANGUAGE_LABELS[d.language]} is missing: ${d.fields.join(', ')}.`);
      }
    }
    setPublishError(e instanceof Error && !isApiError(e) ? e.message : errorMessage(e));
  };

  const publish = useMutation({
    mutationFn: async (scheduledAt: string | null) => {
      await flush();
      return api.admin.help.articles.publish(id, { revision: revision.current, scheduled_at: scheduledAt });
    },
    onSuccess: (a, scheduledAt) => {
      accept(a);
      setPublishError(null);
      setScheduleAt('');
      toast(scheduledAt ? `Scheduled for ${formatDateTime(a.scheduled_at)}` : 'Published — merchants see this version now');
    },
    onError: onActionError,
  });
  const action = useMutation({
    mutationFn: async (kind: 'unpublish' | 'archive' | 'restore' | 'delete') => {
      if (kind === 'unpublish') return api.admin.help.articles.unpublish(id);
      if (kind === 'archive') return api.admin.help.articles.archive(id, archiveReason.trim() || undefined);
      if (kind === 'restore') return api.admin.help.articles.restore(id);
      await api.admin.help.articles.delete(id);
      return null;
    },
    onSuccess: (a, kind) => {
      setConfirm(null);
      setPublishError(null);
      if (!a) {
        void queryClient.invalidateQueries({ queryKey: helpKeys.articles });
        toast('Draft deleted');
        void navigate('/help-articles');
        return;
      }
      accept(a);
      toast({ unpublish: 'Unpublished — merchants no longer see this guide', archive: 'Archived', restore: 'Restored to drafts', delete: '' }[kind]);
    },
    onError: (e) => {
      setConfirm(null);
      onActionError(e);
    },
  });

  const reload = async () => {
    const fresh = await refetch();
    if (fresh.data) {
      const d = draftOf(fresh.data);
      setSavedJson(JSON.stringify(d));
      revision.current = fresh.data.revision;
      setDraft(d);
      setRelated(Object.fromEntries(fresh.data.related.map((r) => [r.id, r])));
    }
    setConflict(false);
  };

  const t = lang === 'en' ? draft.en : draft.bn;
  const setT = (patch: Partial<HelpTranslationInput>) =>
    setDraft((d) => (lang === 'en' ? { ...d, en: { ...d.en, ...patch } } : d.bn ? { ...d, bn: { ...d.bn, ...patch } } : d));

  const status = articleStatusMeta(article.status, article.scheduled_at);
  const live = article.status === 'published';
  const archived = article.status === 'archived';
  const serverUnpublished = article.translations.en.has_unpublished_changes || !!article.translations.bn?.has_unpublished_changes || (!!article.translations.bn !== !!draft.bn && live);
  const unpublishedChanges = live && (serverUnpublished || dirty);
  const enMissing = missingFields(draft.en);
  const bnMissing = draft.bn ? missingFields(draft.bn) : null;
  const bothComplete = !enMissing.length && bnMissing !== null && !bnMissing.length;
  const neverPublished = !article.first_published_at;
  const busy = publish.isPending || action.isPending;
  const feedback = article.feedback;
  const votes = feedback.yes + feedback.no;
  const scheduleIso = dhakaLocalToIso(scheduleAt);
  const scheduleError =
    scheduleAt && (!scheduleIso || new Date(scheduleIso).getTime() < now + 5 * 60_000)
      ? 'Pick a time at least 5 minutes from now.'
      : scheduleIso && new Date(scheduleIso).getTime() > now + 365 * 86_400_000
        ? 'Pick a time within a year.'
        : null;

  const savedLine = save.isPending
    ? 'Saving draft…'
    : conflict
      ? 'Not saved — this article changed somewhere else'
      : dirty
        ? problems.length || slugInvalid
          ? 'Not saved — fix the highlighted fields'
          : 'Unsaved changes'
        : `Draft saved ${ago(lastSavedAt ?? article.updated_at, now)}`;
  const publishedLine = article.last_published_at
    ? ` · last published ${formatDate(article.last_published_at)}${article.last_published_by ? ` by ${article.last_published_by.name}` : ''}`
    : '';

  return (
    <>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-body">
        <Link to="/help-articles" className="text-brand-600 hover:underline">
          Help articles
        </Link>
        <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
        <span className="truncate text-text-secondary">{draft.en.title || 'Untitled'}</span>
      </nav>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-heading-24 text-text-primary">Edit article</h1>
            <Badge size="sm" dot tone={status.tone}>
              {status.label}
            </Badge>
            {unpublishedChanges && (
              <Badge size="sm" dot tone="warning">
                Unpublished changes
              </Badge>
            )}
          </div>
          <p aria-live="polite" className="text-body text-text-secondary">
            {savedLine}
            {publishedLine}
            {live && ' · merchants see the published version until you publish'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="secondary" onClick={() => setPreview(true)}>
            Preview as merchant
          </Button>
          {!archived && (
            <Button loading={publish.isPending && !publish.variables} disabled={busy || conflict || (live && !unpublishedChanges)} onClick={() => publish.mutate(null)}>
              {live ? 'Publish changes' : 'Publish now'}
            </Button>
          )}
        </div>
      </div>

      {(publishError || saveError || problems.length > 0) && (
        <div role="alert" className="flex flex-col gap-1 rounded-md bg-danger-bg px-4 py-3 text-body text-danger">
          {publishError && <span>{publishError}</span>}
          {saveError && <span>{saveError}</span>}
          {problems.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="flex min-w-0 flex-col gap-5 self-start p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-default">
            <Tabs
              aria-label="Language"
              value={lang}
              onChange={setLang}
              className="border-b-0"
              items={[
                { value: 'en', label: 'English' },
                { value: 'bn', label: 'বাংলা' },
              ]}
            />
            {bothComplete ? (
              <Badge size="sm" tone="success">
                Both languages complete
              </Badge>
            ) : !draft.bn ? (
              <Badge size="sm" tone="warning">
                বাংলা missing
              </Badge>
            ) : null}
          </div>

          {!t ? (
            <Empty
              title="No বাংলা version yet"
              description="Merchants who read in বাংলা see the English guide with a note until this is published."
              action={
                <Button variant="secondary" disabled={archived} onClick={() => setDraft((d) => ({ ...d, bn: emptyTranslation() }))}>
                  Add বাংলা translation
                </Button>
              }
            />
          ) : (
            <>
              <Input
                label="Title"
                value={t.title}
                maxLength={HELP_LIMITS.title}
                disabled={archived}
                error={publishError && missingFields(t).includes('title') ? 'Add a title' : undefined}
                onChange={(e) => setT({ title: e.target.value })}
              />
              <Input
                label="Slug (shared by both languages)"
                leading={<span className="text-body text-text-muted">/help/articles/</span>}
                value={draft.slug}
                disabled={archived}
                error={slugError ?? (slugInvalid ? 'Use lowercase letters, numbers and single dashes' : undefined)}
                hint={live ? 'Changing the slug of a live guide keeps the old link working.' : undefined}
                onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value.trim().toLowerCase() }))}
              />
              <label className="flex flex-col gap-1.5">
                <span className="flex justify-between text-body font-medium text-text-primary">
                  <span>Summary · shown in search results</span>
                  <span className={cn('text-caption font-normal', t.summary.length > HELP_LIMITS.summary ? 'text-danger' : 'text-text-muted')}>
                    {t.summary.length} / {HELP_LIMITS.summary}
                  </span>
                </span>
                <textarea
                  rows={2}
                  value={t.summary}
                  maxLength={HELP_LIMITS.summary}
                  disabled={archived}
                  onChange={(e) => setT({ summary: e.target.value })}
                  className="rounded-md border border-border-default bg-surface-card px-3 py-2.5 text-body text-text-primary outline-none focus:border-brand-600 focus:shadow-focus disabled:bg-surface-subtle"
                />
              </label>
              <ArticleBodyField
                key={lang}
                value={t.body}
                onChange={(body) => setT({ body })}
                media={media}
                onMediaAdded={(ref) => setLocalMedia((m) => ({ ...m, [ref.id]: ref }))}
                languageLabel={HELP_LANGUAGE_LABELS[lang]}
                disabled={archived}
              />
              {lang === 'bn' && !archived && (
                <button type="button" onClick={() => setConfirm('remove_bn')} className="self-start text-caption text-danger hover:underline">
                  Remove বাংলা translation
                </button>
              )}
            </>
          )}
        </Card>

        <aside aria-label="Article settings" className="flex flex-col gap-4">
          <section aria-labelledby="publish-heading" className="flex flex-col gap-3 rounded-lg border border-border-default bg-surface-card p-4">
            <h2 id="publish-heading" className="text-body-lg font-semibold text-text-primary">
              Publish
            </h2>
            <div className="flex items-center justify-between text-body">
              <span className="text-text-secondary">Status</span>
              <Badge size="sm" dot tone={status.tone}>
                {status.label}
              </Badge>
            </div>
            {article.status === 'scheduled' && article.scheduled_at && (
              <p className="text-body text-text-secondary">Goes live {formatDateTime(article.scheduled_at)} (Bangladesh time).</p>
            )}
            {article.status === 'draft' && (
              <div className="flex flex-col gap-2">
                <Input
                  type="datetime-local"
                  label="Schedule (Asia/Dhaka)"
                  min={minScheduleLocal()}
                  value={scheduleAt}
                  error={scheduleError ?? undefined}
                  onChange={(e) => setScheduleAt(e.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!scheduleIso || !!scheduleError || busy || conflict}
                  loading={publish.isPending && !!publish.variables}
                  onClick={() => publish.mutate(scheduleIso)}
                >
                  Schedule
                </Button>
              </div>
            )}
            {article.status === 'scheduled' && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => action.mutate('unpublish')}>
                Cancel schedule
              </Button>
            )}
            {live && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirm('unpublish')}>
                Unpublish
              </Button>
            )}
            {archived && (
              <Button variant="secondary" size="sm" loading={action.isPending} onClick={() => action.mutate('restore')}>
                Restore to drafts
              </Button>
            )}
            {article.status === 'draft' && neverPublished && (
              <button type="button" onClick={() => setConfirm('delete')} className="self-start text-caption text-danger hover:underline">
                Delete draft
              </button>
            )}
            <p className="text-caption text-text-muted">English is required. Merchants switch language on the article page; if বাংলা is missing they see English with a note.</p>
          </section>

          <section aria-labelledby="category-heading" className="flex flex-col gap-3 rounded-lg border border-border-default bg-surface-card p-4">
            <h2 id="category-heading" className="text-body-lg font-semibold text-text-primary">
              Category & search
            </h2>
            <Select label="Category" value={draft.category_id} disabled={archived} onChange={(e) => setDraft((d) => ({ ...d, category_id: e.target.value }))}>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_en}
                </option>
              ))}
              {!categories.data?.some((c) => c.id === draft.category_id) && <option value={draft.category_id}>Current category</option>}
            </Select>
            {t && (
              <TagInput
                label={`Search keywords · ${HELP_LANGUAGE_LABELS[lang]}`}
                value={t.keywords}
                max={HELP_LIMITS.keywords}
                maxLength={HELP_LIMITS.keyword}
                disabled={archived}
                placeholder="Add a keyword"
                hint={`Up to ${HELP_LIMITS.keywords}, each under ${HELP_LIMITS.keyword} characters`}
                onChange={(keywords) => setT({ keywords })}
              />
            )}
          </section>

          <RelatedArticlesCard
            articleId={id}
            value={draft.related_article_ids}
            known={related}
            disabled={archived}
            onChange={(ids, picked) => {
              if (picked) setRelated((r) => ({ ...r, [picked.id]: picked }));
              setDraft((d) => ({ ...d, related_article_ids: ids }));
            }}
          />

          <section aria-labelledby="feedback-heading" className="flex flex-col gap-2 rounded-lg border border-border-default bg-surface-card p-4">
            <h2 id="feedback-heading" className="text-body-lg font-semibold text-text-primary">
              Was this helpful? · last 30 days
            </h2>
            {feedback.votes_30d === 0 || feedback.helpful_percent_30d === null ? (
              <p className="text-body text-text-muted">No votes in the last 30 days.</p>
            ) : (
              <p className={cn('text-heading', feedback.helpful_percent_30d < 70 ? 'text-warning' : 'text-text-primary')}>
                {Math.round(feedback.helpful_percent_30d)}% yes · {feedback.votes_30d.toLocaleString('en-US')} votes
              </p>
            )}
            {feedback.top_reasons.length > 0 && (
              <p className="text-body text-text-secondary">
                Top reasons for “No”: {feedback.top_reasons.map((r) => `${HELP_FEEDBACK_REASON_LABELS[r.reason]} (${r.count})`).join(' · ')}
              </p>
            )}
            <p className="text-caption text-text-muted">
              All time: {feedback.yes.toLocaleString('en-US')} yes · {feedback.no.toLocaleString('en-US')} no · {article.views_7d.toLocaleString('en-US')} views this week
            </p>
            {votes > 0 && (
              <button type="button" onClick={() => setFeedbackOpen(true)} className="self-start text-caption font-medium text-brand-600 hover:underline">
                See all feedback
              </button>
            )}
          </section>

          {!archived && (
            <section aria-labelledby="archive-heading" className="flex flex-col gap-2 rounded-lg border border-border-default bg-surface-card p-4">
              <h2 id="archive-heading" className="text-body font-semibold text-danger">
                Archive article
              </h2>
              <p className="text-caption text-text-secondary">Merchants with the link see “This guide was moved”. You can restore it from Archived.</p>
              <Button variant="danger" size="sm" className="self-start" disabled={busy} onClick={() => setConfirm('archive')}>
                Archive
              </Button>
            </section>
          )}
        </aside>
      </div>
      <p className="flex items-center gap-2 text-caption text-text-muted">
        <ShieldCheck aria-hidden className="size-4" />
        Publish, unpublish and archive are saved to the audit log.
      </p>

      {preview && <MerchantPreview draft={draft} lang={lang} media={media} categoryName={categories.data?.find((c) => c.id === draft.category_id)?.name_en ?? ''} onClose={() => setPreview(false)} />}
      <FeedbackDrawer articleId={id} open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      {conflict && (
        <Dialog
          open
          title="This article changed somewhere else"
          description="Someone else saved or published it while you were editing. Reload to get their version — your unsaved edits on this page will be replaced."
          confirmLabel="Reload article"
          cancelLabel="Keep editing"
          onConfirm={() => void reload()}
          onCancel={() => setConflict(false)}
        />
      )}
      {confirm === 'unpublish' && (
        <Dialog
          open
          title="Unpublish this guide?"
          description="Merchants with the link see “This guide was moved or unpublished”. The draft stays here."
          confirmLabel="Unpublish"
          loading={action.isPending}
          onConfirm={() => action.mutate('unpublish')}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'archive' && (
        <Dialog open tone="danger" title="Archive this guide?" description="It leaves Help and search. You can restore it from Archived." confirmLabel="Archive" loading={action.isPending} onConfirm={() => action.mutate('archive')} onCancel={() => setConfirm(null)}>
          <Input label="Reason (optional)" value={archiveReason} maxLength={500} onChange={(e) => setArchiveReason(e.target.value)} />
        </Dialog>
      )}
      {confirm === 'delete' && (
        <Dialog open tone="danger" title="Delete this draft?" description="It was never published, so no merchant has seen it. This can’t be undone." confirmLabel="Delete draft" loading={action.isPending} onConfirm={() => action.mutate('delete')} onCancel={() => setConfirm(null)} />
      )}
      {confirm === 'remove_bn' && (
        <Dialog
          open
          tone="danger"
          title="Remove the বাংলা translation?"
          description={live && article.translations.bn?.published ? 'Merchants keep seeing the published বাংলা version until you publish changes.' : 'The বাংলা draft is deleted.'}
          confirmLabel="Remove বাংলা"
          onConfirm={() => {
            setDraft((d) => ({ ...d, bn: null }));
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}

function MerchantPreview({ draft, lang, media, categoryName, onClose }: { draft: Draft; lang: HelpLanguage; media: Record<string, HelpMediaRef>; categoryName: string; onClose: () => void }) {
  const fallback = lang === 'bn' && !draft.bn;
  const t = fallback || lang === 'en' ? draft.en : draft.bn!;
  const { minutes } = wordStats(t.body);
  const missingImages = docMediaIds(t.body).filter((m) => !media[m]);
  return (
    <Modal open onClose={onClose} title="Preview as merchant" description={`${HELP_LANGUAGE_LABELS[lang]} · draft, not yet published`} size="xl">
      <article aria-label="Merchant preview" className="mx-auto flex max-w-[680px] flex-col gap-3">
        {fallback && <p className="rounded-md bg-info-bg px-3 py-2 text-body text-info">এই লেখাটি এখনো বাংলায় নেই — ইংরেজিতে দেখানো হচ্ছে। / Not available in বাংলা yet — showing English.</p>}
        <span className="text-caption text-text-muted">
          {categoryName} · {minutes} min read
        </span>
        <h2 className="text-heading-24 text-text-primary">{t.title || 'Untitled'}</h2>
        {t.summary && <p className="text-body-lg text-text-secondary">{t.summary}</p>}
        {missingImages.length > 0 && <p className="text-caption text-warning">Some images are still uploading.</p>}
        <HelpArticleBody doc={t.body} media={media} />
      </article>
    </Modal>
  );
}
