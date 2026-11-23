import type { AdminSearchResult } from '@storeplix/types';
import { cn, DomainStatusBadge, Spinner } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { Building, FileText, Globe, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { InvoiceStatusBadge, TenantStatusBadge } from '../components/badges';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { money } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';

interface Item {
  key: string;
  to: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
  trailing: ReactNode;
}

function groups(r: AdminSearchResult): { label: string; items: Item[] }[] {
  return [
    {
      label: 'Shops',
      items: r.tenants.map((t) => ({
        key: `t-${t.id}`,
        to: `/merchants/${t.id}`,
        icon: <Building />,
        title: t.name,
        subtitle: [t.store?.primary_host, t.owner?.phone ?? t.owner?.email].filter(Boolean).join(' · '),
        trailing: <TenantStatusBadge tenant={t} />,
      })),
    },
    {
      label: 'Domains',
      items: r.domains.map((d) => ({
        key: `d-${d.id}`,
        to: `/merchants/${d.tenant.id}?tab=domains`,
        icon: <Globe />,
        title: d.hostname,
        subtitle: d.tenant.name,
        trailing: <DomainStatusBadge status={d.status} />,
      })),
    },
    {
      label: 'Invoices',
      items: r.invoices.map((i) => ({
        key: `i-${i.id}`,
        to: `/billing?invoice=${i.id}`,
        icon: <FileText />,
        title: i.number,
        subtitle: `${i.tenant.name} · ${money(i.total_amount)}`,
        trailing: <InvoiceStatusBadge status={i.status} />,
      })),
    },
  ].filter((g) => g.items.length > 0);
}

// Top bar search 15:246 (460×40, surface-canvas, radius md): "Find a shop, owner phone, domain or invoice" (P8-17).
// ≥ 2 characters → GET /admin/search; results grouped Shops / Domains / Invoices; arrows + Enter, Escape closes.
export function GlobalSearch() {
  const navigate = useNavigate();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const term = useDebounced(q.trim(), 250);
  const [cursor, setCursor] = useState({ term: '', index: 0 });
  // The highlighted option resets whenever the search term changes.
  const active = cursor.term === term ? cursor.index : 0;
  const setActive = (next: number | ((i: number) => number)) =>
    setCursor((c) => ({
      term,
      index: typeof next === 'function' ? next(c.term === term ? c.index : 0) : next,
    }));
  const enabled = term.length >= 2;

  const search = useQuery({
    queryKey: ['admin', 'search', term],
    queryFn: ({ signal }) => api.admin.search(term, { signal }),
    enabled,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const grouped = search.data ? groups(search.data) : [];
  const flat = grouped.flatMap((g) => g.items);

  const go = (item: Item) => {
    setOpen(false);
    setQ('');
    navigate(item.to);
  };

  const showPanel = open && q.trim().length > 0;

  return (
    <div ref={rootRef} className="relative w-full max-w-[460px]">
      <label className="flex h-10 items-center gap-2 rounded-md bg-surface-canvas px-3 focus-within:shadow-focus">
        <Search className="size-4 shrink-0 text-text-muted" aria-hidden />
        <input
          type="search"
          role="combobox"
          aria-label="Search"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showPanel && flat[active] ? `${listId}-${flat[active].key}` : undefined}
          placeholder="Find a shop, owner phone, domain or invoice"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, flat.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && flat[active]) {
              e.preventDefault();
              go(flat[active]);
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
        />
        {search.isFetching && <Spinner size="sm" label="Searching" />}
      </label>
      {showPanel && (
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-[70dvh] overflow-y-auto rounded-lg border border-border-default bg-surface-card py-1.5 shadow-elevation-1"
        >
          {!enabled ? (
            <p className="px-4 py-3 text-caption text-text-muted">Type at least 2 characters.</p>
          ) : search.isPending ? (
            <p className="px-4 py-3 text-caption text-text-muted">Searching…</p>
          ) : search.isError ? (
            <p role="alert" className="px-4 py-3 text-caption text-danger">
              {errorMessage(search.error)}
            </p>
          ) : flat.length === 0 ? (
            <p className="px-4 py-3 text-body text-text-secondary">Nothing matches “{term}”. Try a shop name, owner phone, domain or invoice number.</p>
          ) : (
            grouped.map((g) => (
              <div key={g.label} role="group" aria-label={g.label} className="flex flex-col">
                <p className="px-4 pt-2 pb-1 text-caption font-medium tracking-[0.02em] text-text-muted uppercase">{g.label}</p>
                {g.items.map((item) => {
                  const idx = flat.indexOf(item);
                  return (
                    <div
                      key={item.key}
                      id={`${listId}-${item.key}`}
                      role="option"
                      aria-selected={idx === active}
                      onMouseEnter={() => setActive(idx)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => go(item)}
                      className={cn('mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2', idx === active && 'bg-surface-subtle')}
                    >
                      <span
                        aria-hidden
                        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-text-secondary [&_svg]:size-4"
                      >
                        {item.icon}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body font-medium text-text-primary">{item.title}</span>
                        <span className="truncate text-caption text-text-muted">{item.subtitle}</span>
                      </span>
                      {item.trailing}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
