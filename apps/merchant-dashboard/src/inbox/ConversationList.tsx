import type { InboxChannel, InboxConversationSummary, InboxListMeta, InboxScope, InboxStatus } from '@storeplix/types';
import { INBOX_CHANNELS, INBOX_STATUSES } from '@storeplix/types';
import { Badge, Button, Chip, cn, formatCount, Skeleton } from '@storeplix/ui';
import { AlertTriangle, CheckCircle2, ChevronDown, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NoResults } from '../catalog/states';
import { ChannelIcon, ContactAvatar } from './components';
import { CHANNEL_FILTER_LABELS, rowPreview, rowTitle, SCOPE_LABELS, shortTime, STATUS_LABELS, type InboxUrlState } from './inbox';

// PHASE-8-8E §5, Figma 2118:51165 list column (320): search, status chips with counts, "Mine & unassigned" and
// "All channels" dropdowns, rows; loading 2122:51964, error 2122:52543, all caught up 2122:53073; mobile 2124:1335.

const SCOPES: InboxScope[] = ['mine_unassigned', 'mine', 'unassigned', 'all'];

export function ListHeader({
  state,
  counts,
  onChange,
}: {
  state: InboxUrlState;
  counts: InboxListMeta['counts'] | undefined;
  onChange: (patch: Partial<InboxUrlState>) => void;
}) {
  const [q, setQ] = useState(state.q);
  // follow outside changes of `q` (clear filters, back/forward) by adjusting state during render
  const [seen, setSeen] = useState(state.q);
  if (seen !== state.q) {
    setSeen(state.q);
    setQ(state.q);
  }
  // Debounced search (≥ 2 characters reach the API; shorter = no filter).
  useEffect(() => {
    if (q === state.q) return;
    const t = setTimeout(() => onChange({ q }), 300);
    return () => clearTimeout(t);
  }, [q, state.q, onChange]);

  return (
    <div className="flex flex-col gap-3 p-4">
      <label className="flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2.5 focus-within:shadow-focus">
        <Search aria-hidden className="size-4 shrink-0 text-text-muted" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search chats or phone"
          aria-label="Search conversations"
          className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
        />
      </label>
      <div role="group" aria-label="Status" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
        {INBOX_STATUSES.map((s: InboxStatus) => (
          <Chip key={s} check={false} selected={state.status === s} onClick={() => onChange({ status: s, conversation: null })} className="shrink-0">
            {STATUS_LABELS[s]}
            {counts && s !== 'closed' ? ` · ${formatCount(counts[s])}` : ''}
          </Chip>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <DropdownSelect
          label="Assignee"
          value={state.scope}
          options={SCOPES.map((s) => ({ value: s, label: SCOPE_LABELS[s] }))}
          onChange={(v) => onChange({ scope: v as InboxScope })}
        />
        <DropdownSelect
          label="Channel"
          value={state.channel ?? ''}
          options={[{ value: '', label: 'All channels' }, ...INBOX_CHANNELS.map((c) => ({ value: c, label: CHANNEL_FILTER_LABELS[c] }))]}
          onChange={(v) => onChange({ channel: (v || null) as InboxChannel | null })}
        />
      </div>
    </div>
  );
}

/** Figma "Dropdown · Mine & unassigned": caption text + chevron; a native select underneath for a11y. */
function DropdownSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? options[0]?.label;
  return (
    <span className="relative inline-flex items-center gap-1 text-caption font-medium text-text-secondary focus-within:shadow-focus rounded-sm">
      {current}
      <ChevronDown aria-hidden className="size-3.5" />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function ConversationRow({ c, selected, onSelect }: { c: InboxConversationSummary; selected: boolean; onSelect: () => void }) {
  const unread = c.unread_count > 0;
  const { text, who } = rowPreview(c);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:shadow-focus',
          selected ? 'bg-brand-50' : 'hover:bg-surface-subtle',
        )}
      >
        <ContactAvatar name={c.contact.name} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <ChannelIcon channel={c.channel} />
            <span className={cn('min-w-0 flex-1 truncate text-body text-text-primary', unread ? 'font-semibold' : 'font-medium')}>{rowTitle(c)}</span>
            <span className="shrink-0 text-caption text-text-muted">{shortTime(c.last_message_at)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className={cn('min-w-0 flex-1 truncate text-caption', unread ? 'text-text-primary' : 'text-text-secondary')}>
              {text}
              {text && ' · '}
              <span className={cn(!c.assignee && c.status !== 'closed' && 'text-warning')}>{who}</span>
            </span>
            {c.blocked && (
              <Badge tone="danger" size="sm">
                Blocked
              </Badge>
            )}
            {unread && (
              <span className="shrink-0 rounded-full bg-brand-500 px-1.5 py-px text-caption font-medium text-text-inverse">
                {c.unread_count > 99 ? '99+' : c.unread_count}
                <span className="sr-only"> unread</span>
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

export function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading conversations" className="flex flex-col">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-2.5 w-3/5 rounded-full" />
            <Skeleton className="h-2.5 w-4/5 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Error 2122:52543 — the list retries on its own every 15 s too. */
export function ListError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-danger-bg text-danger">
        <AlertTriangle aria-hidden className="size-6" />
      </span>
      <div className="flex flex-col gap-1">
        <h3 className="text-body-lg font-medium text-text-primary">Couldn’t load conversations</h3>
        <p className="text-body text-text-secondary">Your messages are safe. We’ll try again in a few seconds.</p>
      </div>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** All caught up 2122:53073 (open view with nothing open), or a plain empty state for the other views. */
export function ListEmpty({ state, pending, onViewPending, onClear }: { state: InboxUrlState; pending: number; onViewPending: () => void; onClear: () => void }) {
  if (state.q.trim().length >= 2 || state.channel) {
    return <NoResults title="No conversations match" description="Try another name, phone number or channel." onClear={onClear} clearLabel="Clear filters" />;
  }
  if (state.status === 'open') {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-success-bg text-success">
          <CheckCircle2 aria-hidden className="size-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h3 className="text-body-lg font-medium text-text-primary">All caught up</h3>
          <p className="text-body text-text-secondary">
            No open conversations.
            {pending > 0 && ` ${pending} ${pending === 1 ? 'is' : 'are'} pending — waiting on the customer.`}
          </p>
        </div>
        {pending > 0 && (
          <Button size="sm" variant="secondary" onClick={onViewPending}>
            View pending
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="px-6 py-10 text-center text-body text-text-secondary">{state.status === 'pending' ? 'Nothing is waiting on a customer.' : 'No closed conversations yet.'}</div>
  );
}
