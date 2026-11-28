import type { HelpArticle, HelpFeedbackReason, HelpLanguage } from '@storeplix/types';
import { HELP_FEEDBACK_REASON_LABELS, HELP_FEEDBACK_REASONS, HELP_LIMITS } from '@storeplix/types';
import { Badge, Button, Chip, cn, HelpArticleBody, Skeleton } from '@storeplix/ui';
import { AlertTriangle, ChevronDown, Info, MessageCircle, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock, StateCard } from '../catalog/states';
import { useReadOnly } from '../impersonation/hooks';
import { toast } from '../online-store/components/Toast';
import { ArticleLinkRow, BannerButton, bnClass, categoryPath, ContactCard, HelpBanner, HelpBreadcrumb, LanguageToggle } from './components';
import { helpErrorText, isNotFound } from './errors';
import { canContactSupport, FALLBACK_NOTE, formatHelpDate, rememberHelpLanguage, resolveHelpLanguage } from './help';
import { useNewTicket } from './NewTicketModal';
import { useArticleVote, useHelpArticle } from './queries';

// PHASE-8-9C §13 Article 71:21665 / mobile 2132:55211 (`/help/articles/:slug?lang=bn`): breadcrumb Help center ›
// topic, topic tag + "Updated {date} · n min read", language toggle, fallback note (P89C-2), title, summary as intro,
// HelpArticleBody, On this page (desktop aside, mobile collapsible), Was this helpful Yes / No + count, No → reason
// card → Send feedback, thanks banner with Undo, Related articles, Still stuck (Create a ticket only). 404 state
// "This guide was moved or unpublished". A renamed slug (`slug` ≠ requested) replaces the URL.

const BN = {
  onThisPage: 'এই পাতায়',
  helpful: 'এই লেখাটি কি কাজে লেগেছে?',
  related: 'সম্পর্কিত গাইড',
} as const;

export function HelpArticlePage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const lang = resolveHelpLanguage(params.get('lang'));
  const article = useHelpArticle(slug, lang);

  // §5: a redirected slug answers 200 with the canonical slug — replace the URL.
  const canonical = article.data?.slug;
  useEffect(() => {
    if (canonical && canonical !== slug) void navigate({ pathname: `/help/articles/${encodeURIComponent(canonical)}`, search: params.toString() }, { replace: true });
  }, [canonical, slug, navigate, params]);

  const setLang = (l: HelpLanguage) => {
    rememberHelpLanguage(l);
    setParams(l === 'bn' ? { lang: 'bn' } : {}, { replace: true });
  };

  if (article.isError && isNotFound(article.error)) return <ArticleNotFound />;
  if (article.isError)
    return (
      <StateCard>
        <ErrorBlock title="We couldn’t load this guide" message={helpErrorText(article.error)} onRetry={() => void article.refetch()} />
      </StateCard>
    );
  if (article.isPending) return <ArticleSkeleton />;
  return <ArticleView a={article.data} lang={lang} onLang={setLang} />;
}

function ArticleView({ a, lang, onLang }: { a: HelpArticle; lang: HelpLanguage; onLang: (l: HelpLanguage) => void }) {
  const { activeTenant } = useAuth();
  const ticket = useNewTicket();
  const canContact = canContactSupport(activeTenant);
  const served = a.language;
  const bn = served === 'bn';
  const [tocOpen, setTocOpen] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      {ticket.banner}
      <HelpBreadcrumb items={[{ label: 'Help center', to: '/help' }, { label: a.category.name, to: categoryPath(a.category.slug, lang) }, { label: a.title }]} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)_280px]">
        {a.toc.length > 0 && (
          <nav aria-label="On this page" className="hidden lg:block">
            <div className="sticky top-20 flex flex-col gap-2">
              <span className="text-caption font-medium tracking-wide text-text-muted uppercase">On this page</span>
              <ul className={cn('flex flex-col border-l border-border-default', bnClass(served))}>
                {a.toc.map((t) => (
                  <li key={t.id}>
                    <a href={`#${t.id}`} className={cn('block py-2 text-body text-text-secondary hover:text-brand-600', t.level === 3 ? 'pl-6' : 'pl-3')}>
                      {t.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        )}

        <article lang={served} className={cn('flex min-w-0 flex-col gap-6 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 sm:p-9', a.toc.length === 0 && 'lg:col-span-2 xl:col-span-2')}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <Link to={categoryPath(a.category.slug, lang)}>
                <Badge tone="brand" size="sm" className={bnClass(served)}>
                  {a.category.name}
                </Badge>
              </Link>
              <span className="text-caption text-text-muted">
                Updated {formatHelpDate(a.updated_at, { year: true })} · {a.read_minutes} min read
              </span>
            </div>
            <LanguageToggle value={lang} onChange={onLang} />
          </div>
          {a.fallback && (
            <div role="note" className="flex items-start gap-2.5 rounded-lg bg-info-bg px-4 py-3 text-body text-text-primary">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
              <span>
                <span className="font-bangla">{FALLBACK_NOTE.bn}</span>
                <span className="block text-caption text-text-secondary">{FALLBACK_NOTE.en}</span>
              </span>
            </div>
          )}
          <div className={cn('flex flex-col gap-4', bnClass(served))}>
            <h1 className="text-heading-24 text-text-primary sm:text-heading-32">{a.title}</h1>
            {a.summary && <p className="text-body-lg text-text-secondary">{a.summary}</p>}
          </div>

          {a.toc.length > 0 && (
            <div className="rounded-lg border border-border-default lg:hidden">
              <button
                type="button"
                aria-expanded={tocOpen}
                onClick={() => setTocOpen((o) => !o)}
                className={cn('flex w-full items-center gap-2 px-4 py-3 text-body font-medium text-text-primary', bnClass(served))}
              >
                <span className="flex-1 text-left">
                  {bn ? BN.onThisPage : 'On this page'} · {a.toc.length}
                </span>
                <ChevronDown aria-hidden className={cn('size-4 text-text-muted transition-transform', tocOpen && 'rotate-180')} />
              </button>
              {tocOpen && (
                <ul className={cn('flex flex-col border-t border-border-default px-4 py-2', bnClass(served))}>
                  {a.toc.map((t) => (
                    <li key={t.id}>
                      <a href={`#${t.id}`} onClick={() => setTocOpen(false)} className={cn('block py-1.5 text-body text-text-secondary', t.level === 3 && 'pl-4')}>
                        {t.text}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <HelpArticleBody
            doc={a.body}
            media={a.media}
            toc={a.toc}
            language={served}
            renderInternalLink={(href, children) => (
              <Link to={href} className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
                {children}
              </Link>
            )}
          />

          <HelpfulBlock a={a} />
        </article>

        <aside className="flex flex-col gap-4 lg:col-span-2 xl:col-span-1">
          {a.related.length > 0 && (
            <section aria-labelledby="related-articles" className="flex flex-col rounded-card border border-border-default bg-surface-card px-5 pt-5 pb-2 shadow-elevation-1">
              <h2 id="related-articles" className={cn('text-body-lg font-medium text-text-primary', bnClass(served))}>
                {bn ? BN.related : 'Related articles'}
              </h2>
              <div className="flex flex-col divide-y divide-border-default">
                {a.related.map((r) => (
                  <ArticleLinkRow key={r.id} link={r} lang={lang} className="py-3.5" />
                ))}
              </div>
            </section>
          )}
          <ContactCard variant="stuck" canContact={canContact} onNewTicket={ticket.open} />
        </aside>
      </div>
      {ticket.modal}
    </div>
  );
}

/** "Was this article helpful?" (71:21665) → No reasons card (2130:965) → thanks banner with Undo. */
function HelpfulBlock({ a }: { a: HelpArticle }) {
  const readOnly = useReadOnly();
  const { vote, unvote } = useArticleVote(a);
  const myVote = a.helpful.my_vote;
  const [askingWhy, setAskingWhy] = useState(false);
  const [reason, setReason] = useState<HelpFeedbackReason | null>(null);
  const [note, setNote] = useState('');
  const noteId = useId();
  const bn = a.language === 'bn';
  const yes = a.helpful.yes_count;
  const busy = vote.isPending || unvote.isPending;

  const send = (helpful: boolean) =>
    vote.mutate(
      { helpful, language: a.language, reason: helpful ? null : reason, note: helpful ? null : note.trim() || null },
      {
        onSuccess: () => {
          setAskingWhy(false);
          setReason(null);
          setNote('');
        },
        onError: (e) => toast(helpErrorText(e, 'We couldn’t save your feedback.'), 'error'),
      },
    );
  const undo = () => unvote.mutate(undefined, { onError: (e) => toast(helpErrorText(e, 'We couldn’t undo your feedback.'), 'error') });

  if (myVote) {
    return (
      <HelpBanner
        tone="info"
        action={
          !readOnly && (
            <BannerButton onClick={undo}>
              Undo
            </BannerButton>
          )
        }
      >
        {myVote.helpful ? (yes >= HELP_LIMITS.helpfulCountMin ? `Thanks — ${yes} sellers found this helpful.` : 'Thanks — glad it helped.') : 'Thanks for telling us. We read every note and fix the guide.'}
      </HelpBanner>
    );
  }

  if (askingWhy) {
    return (
      <section aria-labelledby={`${noteId}-why`} className="flex flex-col items-center gap-4 rounded-card border border-border-default px-5 py-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-subtle text-text-secondary">
          <MessageCircle aria-hidden className="size-6" />
        </span>
        <h2 id={`${noteId}-why`} className="text-body-lg font-medium text-text-primary">
          Sorry it didn’t help. What was missing?
        </h2>
        <div role="group" aria-label="Reason" className="flex flex-wrap justify-center gap-2">
          {HELP_FEEDBACK_REASONS.map((r) => (
            <Chip key={r} check={false} selected={reason === r} onClick={() => setReason(reason === r ? null : r)}>
              {HELP_FEEDBACK_REASON_LABELS[r]}
            </Chip>
          ))}
        </div>
        <label htmlFor={noteId} className="text-body text-text-secondary">
          Optional: tell us more. We read every note and fix the guide.
        </label>
        <textarea
          id={noteId}
          rows={3}
          maxLength={HELP_LIMITS.feedbackNote}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full max-w-md rounded-control border border-border-default bg-surface-card px-3 py-2 text-body text-text-primary outline-none focus:border-brand-600 focus:shadow-focus"
        />
        <div className="flex gap-3">
          <Button variant="secondary" size="sm" onClick={() => setAskingWhy(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || readOnly} onClick={() => send(false)}>
            Send feedback
          </Button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border-default pt-5 sm:flex-row sm:items-center">
      <span className={cn('text-body font-medium text-text-primary', bn && 'font-bangla')}>{bn ? BN.helpful : 'Was this article helpful?'}</span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={busy || readOnly} onClick={() => send(true)}>
          <ThumbsUp aria-hidden className="size-4" />
          Yes
        </Button>
        <Button variant="secondary" size="sm" disabled={busy || readOnly} onClick={() => setAskingWhy(true)}>
          <ThumbsDown aria-hidden className="size-4" />
          No
        </Button>
      </div>
      {yes >= HELP_LIMITS.helpfulCountMin && <span className="text-caption text-text-muted sm:ml-auto">{yes} sellers found this helpful</span>}
    </div>
  );
}

function ArticleNotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-5">
      <HelpBreadcrumb items={[{ label: 'Help center', to: '/help' }, { label: 'Guide' }]} />
      <StateCard>
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-danger-bg text-text-secondary">
            <AlertTriangle aria-hidden className="size-6" />
          </span>
          <h1 className="text-body-lg font-medium text-text-primary">This guide was moved or unpublished</h1>
          <p className="max-w-sm text-body text-text-secondary">We may have merged it with a newer guide. Search for the topic or go back to the Help center.</p>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => void navigate('/help')}>
              Help center
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void navigate('/help?q=')}>
              Search guides
            </Button>
          </div>
        </div>
      </StateCard>
    </div>
  );
}

function ArticleSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading guide" className="flex flex-col gap-5">
      <Skeleton className="h-4 w-64" />
      <div className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-9 shadow-elevation-1">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    </div>
  );
}

export default HelpArticlePage;
