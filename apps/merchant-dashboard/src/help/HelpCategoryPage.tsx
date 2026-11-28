import type { HelpLanguage } from '@storeplix/types';
import { Button, cn } from '@storeplix/ui';
import { BookOpen } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock, LoadingRows, StateCard } from '../catalog/states';
import { ArticleLinkRow, bnClass, CategoryIcon, ContactCard, HelpBreadcrumb, HelpSearchBox, LanguageToggle } from './components';
import { helpErrorText, isNotFound } from './errors';
import { canContactSupport, helpSearchParams, rememberHelpLanguage, resolveHelpLanguage } from './help';
import { useNewTicket } from './NewTicketModal';
import { useHelpCategory } from './queries';

// PHASE-8-9C §13 Topic (`/help/categories/:slug`, alias `/help/topics/:slug`): composed from the search layout —
// category title + description + article rows, with the search bar and the contact aside. Unknown / empty topic → 404
// state.

export function HelpCategoryPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { activeTenant } = useAuth();
  const lang = resolveHelpLanguage(params.get('lang'));
  const page = useHelpCategory(slug, lang);
  const ticket = useNewTicket();
  const canContact = canContactSupport(activeTenant);

  const setLang = (l: HelpLanguage) => {
    rememberHelpLanguage(l);
    setParams(l === 'bn' ? { lang: 'bn' } : {}, { replace: true });
  };

  if (page.isError && isNotFound(page.error)) {
    return (
      <div className="flex flex-col gap-5">
        <HelpBreadcrumb items={[{ label: 'Help center', to: '/help' }, { label: 'Topic' }]} />
        <StateCard>
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-surface-subtle text-text-secondary">
              <BookOpen aria-hidden className="size-6" />
            </span>
            <h1 className="text-body-lg font-medium text-text-primary">This topic has no guides right now</h1>
            <p className="max-w-sm text-body text-text-secondary">It may have been renamed. Browse all topics on the Help center.</p>
            <Button size="sm" onClick={() => void navigate('/help')}>
              Help center
            </Button>
          </div>
        </StateCard>
      </div>
    );
  }

  const cat = page.data?.category;
  return (
    <div className="flex flex-col gap-5">
      {ticket.banner}
      <HelpBreadcrumb items={[{ label: 'Help center', to: '/help' }, { label: cat?.name ?? 'Topic' }]} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {cat && (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <CategoryIcon icon={cat.icon} className="size-5" />
            </span>
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className={cn('text-heading-24 text-text-primary', bnClass(lang))}>{cat?.name ?? 'Topic'}</h1>
            {cat?.description && <p className={cn('text-body text-text-secondary', bnClass(lang))}>{cat.description}</p>}
          </div>
        </div>
        <LanguageToggle value={lang} onChange={setLang} label="Guide language" />
      </div>
      <HelpSearchBox onSearch={(q) => void navigate(`/help?${helpSearchParams({ q, language: 'both', category: slug })}`)} className="shadow-none" />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <section aria-label="Articles" className="flex min-w-0 flex-1 flex-col rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          {page.isPending ? (
            <LoadingRows rows={5} label="Loading articles" />
          ) : page.isError ? (
            <ErrorBlock title="We couldn’t load this topic" message={helpErrorText(page.error)} onRetry={() => void page.refetch()} />
          ) : (
            <>
              <div className="border-b border-border-default px-5 py-4 text-body text-text-secondary">
                {page.data.articles.length} {page.data.articles.length === 1 ? 'article' : 'articles'}
              </div>
              <div className="flex flex-col divide-y divide-border-default px-5">
                {page.data.articles.map((a) => (
                  <ArticleLinkRow key={a.id} link={a} lang={lang} className="py-4" />
                ))}
              </div>
            </>
          )}
        </section>
        <aside className="flex flex-col gap-4 lg:w-[330px] lg:shrink-0">
          <ContactCard variant="search" canContact={canContact} onNewTicket={ticket.open} />
          <Link to="/help" className="text-body font-medium text-brand-600 hover:underline">
            ← All topics
          </Link>
        </aside>
      </div>
      {ticket.modal}
    </div>
  );
}

export default HelpCategoryPage;
