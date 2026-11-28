import { HELP_LIMITS } from '@storeplix/types';
import { Badge, Button } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useDebounced } from '../lib/useDebounced';
import { helpKeys } from './queries';

export interface RelatedRef {
  id: string;
  title: string;
  status?: string;
}

// Related articles (P89C-10): staff pick ≤ 5; unpublished picks are skipped for merchants (shown with their status).
export function RelatedArticlesCard({
  articleId,
  value,
  known,
  onChange,
  disabled,
}: {
  articleId: string;
  value: string[];
  known: Record<string, RelatedRef>;
  onChange: (ids: string[], picked?: RelatedRef) => void;
  disabled?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const search = useQuery({
    queryKey: [...helpKeys.articles, 'related-search', term],
    queryFn: () => api.admin.help.articles.list({ q: term, per_page: 8 }),
    enabled: adding && term.length >= 2,
  });
  const results = (search.data?.data ?? []).filter((a) => a.id !== articleId && !value.includes(a.id));
  const full = value.length >= HELP_LIMITS.related;

  return (
    <section aria-labelledby="related-heading" className="flex flex-col gap-3 rounded-lg border border-border-default bg-surface-card p-4">
      <h2 id="related-heading" className="text-body-lg font-semibold text-text-primary">
        Related articles
      </h2>
      {value.length === 0 && <p className="text-caption text-text-muted">None picked — merchants see popular guides from the same category.</p>}
      <ul className="flex flex-col gap-2">
        {value.map((id) => {
          const r = known[id];
          return (
            <li key={id} className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="text-body text-text-primary">{r?.title || 'Untitled article'}</span>
                {r?.status && r.status !== 'published' && (
                  <Badge size="sm" tone="neutral" className="self-start">
                    {r.status} · hidden from merchants
                  </Badge>
                )}
              </span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${r?.title || 'related article'}`}
                  onClick={() => onChange(value.filter((v) => v !== id))}
                  className="shrink-0 rounded-sm text-caption text-text-secondary outline-none hover:text-danger focus-visible:shadow-focus"
                >
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!disabled &&
        (adding ? (
          <div className="flex flex-col gap-2">
            <label className="flex h-9 items-center gap-2 rounded-md border border-border-default px-2.5 focus-within:border-brand-600">
              <Search aria-hidden className="size-4 text-text-muted" />
              <input
                autoFocus
                type="search"
                aria-label="Search articles to relate"
                placeholder="Search articles"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
              />
            </label>
            {term.length >= 2 && (
              <ul aria-label="Matching articles" className="flex flex-col">
                {search.isPending ? (
                  <li className="text-caption text-text-muted">Searching…</li>
                ) : results.length === 0 ? (
                  <li className="text-caption text-text-muted">No other articles match.</li>
                ) : (
                  results.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        disabled={full}
                        onClick={() => {
                          onChange([...value, a.id], { id: a.id, title: a.title, status: a.status });
                          setQ('');
                        }}
                        className="w-full rounded-sm px-2 py-1.5 text-left text-body text-text-primary outline-none hover:bg-surface-subtle focus-visible:shadow-focus disabled:opacity-50"
                      >
                        {a.title || a.slug}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setAdding(false)}>
              Done
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="secondary" className="self-start" disabled={full} onClick={() => setAdding(true)}>
            {full ? `Up to ${HELP_LIMITS.related} related articles` : 'Add related article'}
          </Button>
        ))}
    </section>
  );
}
