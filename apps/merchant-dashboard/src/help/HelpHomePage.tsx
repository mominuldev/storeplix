import type { HelpLanguage } from '@storeplix/types';
import { Badge, Button, cn, Skeleton } from '@storeplix/ui';
import { ChevronRight } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock, LoadingRows, StateCard } from '../catalog/states';
import { useReadOnly } from '../impersonation/hooks';
import { articlePath, ArticleLinkRow, bnClass, ContactCard, HelpSearchBox, LanguageToggle, TopicCard, useFirstName } from './components';
import { canContactSupport, helpSearchParams, rememberHelpLanguage, resolveHelpLanguage } from './help';
import { HelpSearchView } from './HelpSearchView';
import { useNewTicket } from './NewTicketModal';
import { useHelpHome, useTicketList } from './queries';

// PHASE-8-9C §13 Help home 71:21272 / mobile 2131:1440 (`/help`; `/help?q=` renders the search view 2130:463): title +
// English / বাংলা toggle, hero "Hi {first name}, how can we help today?" + search + 4 popular chips, Browse by topic,
// Popular this week, Talk to us (Email & tickets only); mobile My tickets row + sticky Contact support. Not built
// (Q327/Q328): status strip, live chat, call, WhatsApp, videos, AI box, setup checklist.

export function HelpPage() {
  const [params] = useSearchParams();
  return params.has('q') ? <HelpSearchView /> : <HelpHome />;
}

function HelpHome() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { activeTenant } = useAuth();
  const readOnly = useReadOnly();
  const lang = resolveHelpLanguage(params.get('lang'));
  const home = useHelpHome(lang);
  const firstName = useFirstName();
  const canContact = home.data?.can_contact_support ?? canContactSupport(activeTenant);
  const ticket = useNewTicket();
  const counts = useTicketList({ per_page: 1 });

  const setLang = (l: HelpLanguage) => {
    rememberHelpLanguage(l);
    const p = new URLSearchParams(params);
    if (l === 'bn') p.set('lang', 'bn');
    else p.delete('lang');
    setParams(p, { replace: true });
  };
  const search = (q: string) => void navigate(`/help?${helpSearchParams({ q, language: 'both', category: null })}`);
  const popular = home.data?.popular ?? [];
  const waiting = counts.data?.meta.counts.waiting_on_you ?? 0;
  const openCount = counts.data?.meta.counts.open ?? 0;

  return (
    <div className="flex flex-col gap-6 pb-20 lg:pb-0">
      {ticket.banner}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-heading-24 text-text-primary">Help center</h1>
          <p className="text-body text-text-secondary">
            Guides and real people — in English and <span className="font-bangla">বাংলা</span>.
          </p>
        </div>
        <LanguageToggle value={lang} onChange={setLang} label="Guide language" />
      </div>

      <section aria-label="Search the help center" className="flex flex-col gap-4 rounded-card border border-brand-700 bg-brand-600 px-5 py-6 shadow-elevation-1 sm:px-10 sm:py-9">
        <h2 className="text-heading text-text-inverse sm:text-heading-24">{firstName ? `Hi ${firstName}, how can we help today?` : 'How can we help today?'}</h2>
        <HelpSearchBox onSearch={search} />
        {popular.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body text-brand-100">Popular:</span>
            {popular.slice(0, 4).map((a) => (
              <Link key={a.id} to={articlePath(a.slug, lang)} className={cn('rounded-full bg-brand-700 px-3 py-1.5 text-caption font-medium text-text-inverse outline-none hover:bg-brand-500 focus-visible:shadow-focus', bnClass(a.language))}>
                {a.title}
              </Link>
            ))}
          </div>
        )}
      </section>

      {canContact && counts.data && (
        <Link to="/help/tickets" className="flex items-center gap-3 rounded-card border border-border-default bg-surface-card px-4 py-3.5 shadow-elevation-1 outline-none focus-visible:shadow-focus lg:hidden">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-medium text-text-primary">My tickets</span>
            <span className="text-caption text-text-muted">
              {waiting} waiting on you · {openCount} open
            </span>
          </span>
          {waiting > 0 && <Badge tone="warning">Reply needed</Badge>}
          <ChevronRight aria-hidden className="size-4 text-text-muted" />
        </Link>
      )}

      {home.isPending ? (
        <div aria-busy="true" aria-label="Loading help center" className="flex flex-col gap-4">
          <Skeleton className="h-7 w-48" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-40 rounded-card" />
            ))}
          </div>
          <StateCard>
            <LoadingRows rows={4} label="Loading articles" />
          </StateCard>
        </div>
      ) : home.isError ? (
        <StateCard>
          <ErrorBlock title="We couldn’t load the help center" error={home.error} onRetry={() => void home.refetch()} />
        </StateCard>
      ) : (
        <>
          <section aria-labelledby="help-topics" className="flex flex-col gap-4">
            <div className="flex items-end gap-2">
              <h2 id="help-topics" className="flex-1 text-heading text-text-primary">
                Browse by topic
              </h2>
              <span className="text-body font-medium text-text-secondary">
                {home.data.total_articles} {home.data.total_articles === 1 ? 'article' : 'articles'}
              </span>
            </div>
            {home.data.categories.length === 0 ? (
              <StateCard>
                <p className="px-6 py-10 text-center text-body text-text-secondary">No guides are published yet. Check back soon.</p>
              </StateCard>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {home.data.categories.map((c) => (
                  <TopicCard key={c.id} category={c} lang={lang} />
                ))}
              </div>
            )}
          </section>

          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
            <section aria-labelledby="help-popular" className="flex min-w-0 flex-1 flex-col rounded-card border border-border-default bg-surface-card px-5 pt-5 pb-2 shadow-elevation-1">
              <h2 id="help-popular" className="text-body-lg font-medium text-text-primary">
                Popular this week
              </h2>
              {popular.length === 0 ? (
                <p className="py-4 text-body text-text-secondary">Popular guides show up here once sellers start reading.</p>
              ) : (
                <div className="flex flex-col divide-y divide-border-default">
                  {popular.map((a) => (
                    <ArticleLinkRow key={a.id} link={a} lang={lang} className="py-3.5" />
                  ))}
                </div>
              )}
            </section>
            <div className="lg:w-[320px] lg:shrink-0">
              <ContactCard variant="home" canContact={canContact} onNewTicket={ticket.open} />
            </div>
          </div>
        </>
      )}

      {canContact && (
        <div className="fixed inset-x-0 bottom-16 z-20 border-t border-border-default bg-surface-card p-3 lg:hidden">
          <Button className="w-full" disabled={readOnly} onClick={ticket.open}>
            Contact support
          </Button>
        </div>
      )}
      {ticket.modal}
    </div>
  );
}

export default HelpPage;
