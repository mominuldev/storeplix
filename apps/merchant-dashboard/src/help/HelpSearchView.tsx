import type { HelpSearchLanguage, HelpSearchResult } from '@storeplix/types';
import { Badge, Button, Chip, cn } from '@storeplix/ui';
import { ChevronRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock, LoadingRows, NoResults } from '../catalog/states';
import { articlePath, bnClass, ContactCard, HelpBreadcrumb, HelpSearchBox } from './components';
import { helpErrorText } from './errors';
import { canContactSupport, highlightParts, helpSearchParams, isSearchable, parseHelpSearch } from './help';
import { useNewTicket } from './NewTicketModal';
import { useHelpHome, useHelpSearch } from './queries';

// PHASE-8-9C §13 Search 2130:463 (`/help?q=&language=&category=`): breadcrumb, search bar, Language chips Both /
// English / বাংলা, "n results for “q”" + category chips with counts, result rows 2130:451 (query terms bolded by the
// UI, no HTML from the API), Show more (next page), aside "Didn't find your answer?" (Contact support → New ticket;
// no live chat), Popular searches = popular article titles, Search tips. No results state from 2130:965.

const LANGS: { value: HelpSearchLanguage; label: string; bn?: boolean }[] = [
  { value: 'both', label: 'Both' },
  { value: 'en', label: 'English' },
  { value: 'bn', label: 'বাংলা', bn: true },
];

export function HelpSearchView() {
  const [params, setParams] = useSearchParams();
  const { activeTenant } = useAuth();
  const state = parseHelpSearch(params);
  const searchable = isSearchable(state.q);
  const results = useHelpSearch({ q: state.q.trim(), language: state.language, category: state.category ?? undefined, per_page: 20 }, searchable);
  const home = useHelpHome('en');
  const canContact = home.data?.can_contact_support ?? canContactSupport(activeTenant);
  const ticket = useNewTicket();

  const go = (next: Partial<typeof state>) => setParams(helpSearchParams({ ...state, ...next }), { replace: false });
  const rows = results.data?.pages.flatMap((p) => p.data) ?? [];
  const meta = results.data?.pages[0]?.meta;
  const total = meta?.total ?? 0;
  const counts = meta?.counts_by_category ?? [];
  const countsTotal = counts.reduce((s, c) => s + c.count, 0);

  return (
    <div className="flex flex-col gap-5">
      {ticket.banner}
      <HelpBreadcrumb items={[{ label: 'Help center', to: '/help' }, { label: 'Search' }]} />
      <div className="flex flex-col gap-1">
        <h1 className="text-heading-24 text-text-primary">Search the help center</h1>
        <p className="text-body text-text-secondary">
          Guides in English and <span className="font-bangla">বাংলা</span>. Search in either language — we match both.
        </p>
      </div>
      <HelpSearchBox key={state.q} initial={state.q} onSearch={(q) => go({ q, category: null })} onClear={() => go({ q: '', category: null })} className="shadow-none" />
      <div role="group" aria-label="Language" className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-body text-text-secondary">Language</span>
        {LANGS.map((l) => (
          <Chip key={l.value} check={false} selected={state.language === l.value} onClick={() => go({ language: l.value, category: null })} className={l.bn ? 'font-bangla' : undefined}>
            {l.label}
          </Chip>
        ))}
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <section aria-label="Results" className="flex min-w-0 flex-1 flex-col rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          {!searchable ? (
            <NoResults title="Type at least 2 characters" description="Search an order number, an error message or a few words in English or বাংলা." />
          ) : results.isPending ? (
            <LoadingRows rows={5} label="Loading articles" />
          ) : results.isError ? (
            <ErrorBlock title="We couldn’t search the guides" message={helpErrorText(results.error)} onRetry={() => void results.refetch()} />
          ) : rows.length === 0 && !state.category ? (
            <NoResults
              title={
                <>
                  No guides match “<span className="font-bangla">{state.q}</span>”
                </>
              }
              description="Try fewer words, or English and বাংলা both. Still stuck? Our team can look at it."
              onClear={canContact ? ticket.open : undefined}
              clearLabel="Contact support"
            />
          ) : (
            <>
              <div className="flex flex-col gap-4 border-b border-border-default p-5">
                <div className="flex items-baseline gap-3">
                  <h2 className="flex-1 text-heading text-text-primary">
                    {total} {total === 1 ? 'result' : 'results'} for “{state.q.trim()}”
                  </h2>
                  <span className="hidden text-caption text-text-muted sm:inline">Best match first</span>
                </div>
                {counts.length > 0 && (
                  <div role="group" aria-label="Topic" className="flex flex-wrap gap-2">
                    <Chip check={false} selected={!state.category} onClick={() => go({ category: null })}>
                      All {countsTotal || total}
                    </Chip>
                    {counts.map((c) => (
                      <Chip key={c.category.id} check={false} selected={state.category === c.category.slug} onClick={() => go({ category: c.category.slug })}>
                        {c.category.name} {c.count}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
              <ul className="flex flex-col divide-y divide-border-default">
                {rows.map((r) => (
                  <li key={`${r.article_id}-${r.language}`}>
                    <ResultRow r={r} q={state.q} />
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-3 border-t border-border-default px-5 py-4">
                <span className="flex-1 text-caption text-text-muted">
                  Showing {rows.length} of {total}
                </span>
                {results.hasNextPage && (
                  <Button size="sm" variant="secondary" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
                    Show more results
                  </Button>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="flex flex-col gap-4 lg:w-[330px] lg:shrink-0">
          <ContactCard variant="search" canContact={canContact} onNewTicket={ticket.open} />
          {(home.data?.popular.length ?? 0) > 0 && (
            <section className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
              <h2 className="text-body font-semibold text-text-primary">Popular searches</h2>
              <div className="flex flex-wrap gap-2">
                {home.data!.popular.slice(0, 6).map((a) => (
                  <Link key={a.id} to={articlePath(a.slug, a.language)} className={cn('rounded-full border border-border-default px-3.5 py-2 text-body text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus', bnClass(a.language))}>
                    {a.title}
                  </Link>
                ))}
              </div>
            </section>
          )}
          <section className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
            <h2 className="text-body font-semibold text-text-primary">Search tips</h2>
            <p className="text-body text-text-secondary">
              Search an error message or a feature name to find the right fix. Bangla and English words both work: “<span className="font-bangla">রিফান্ড</span>” finds refund guides.
            </p>
          </section>
        </aside>
      </div>
      {ticket.modal}
    </div>
  );
}

function ResultRow({ r, q }: { r: HelpSearchResult; q: string }) {
  return (
    <Link to={articlePath(r.slug, r.language)} className="flex items-center gap-4 px-5 py-4 outline-none hover:bg-surface-subtle focus-visible:shadow-focus">
      <span className={cn('flex min-w-0 flex-1 flex-col gap-1', bnClass(r.language))} lang={r.language}>
        <span className="text-body-lg font-medium text-text-primary">{r.title}</span>
        <span className="text-body text-text-secondary">
          {highlightParts(r.snippet, q).map((part, i) =>
            part.hit ? (
              <strong key={i} className="font-semibold text-text-primary">
                {part.text}
              </strong>
            ) : (
              <span key={i}>{part.text}</span>
            ),
          )}
        </span>
        <span className="flex flex-wrap items-center gap-2 pt-0.5">
          <Badge size="sm">{r.category.name}</Badge>
          <Badge size="sm" tone="brand" className={r.language === 'bn' ? 'font-bangla' : 'font-sans'}>
            {r.language === 'bn' ? 'বাংলা' : 'English'}
          </Badge>
          <span className="text-caption text-text-muted">{r.read_minutes} min read</span>
        </span>
      </span>
      <ChevronRight aria-hidden className="size-5 shrink-0 text-text-muted" />
    </Link>
  );
}
