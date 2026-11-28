import type { PlatformSmsGroup, PlatformSmsLogEntry, SmsMessageStatus } from '@storeplix/types';
import { Badge, Button, Chip, cn, Input, Select } from '@storeplix/ui';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Download, Lock, MessageSquare, Search, SearchX } from 'lucide-react';
import { useState } from 'react';
import { CursorFooter } from '../../audit/CursorFooter';
import { useCursorPages } from '../../audit/useCursorPages';
import { Empty, ErrorState, LoadingRows } from '../../components/States';
import { api } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { useDebounced } from '../../lib/useDebounced';
import { useToast } from '../../lib/toast';
import { relativeDay } from '../../sms/format';
import { defaultLogFilters, dhakaDaysAgo, groupShortLabel, groupTone, logStatusMeta, toLogQuery, typeLabel, type LogFilterState } from './format';
import { platformSmsKeys, smsErrorText } from './queries';
import { SectionCard } from './ui';

// SMS log tab (PHASE-8-9B §11.6, Figma 2098:10472): search "Phone number or shop", Status select, date range (default
// 30 days, min −90), Type chips → `group`, Export CSV (same filters, masked). Table TIME · PHONE · MERCHANT · TYPE ·
// MESSAGE (codes: lock + "Code hidden") · PARTS · STATUS (provider in a tooltip). Cursor Previous / Next. States:
// empty "No platform SMS yet" + Send test SMS, no match + Clear filters, skeleton. 390 px: rows become cards.

const TYPE_CHIPS: { value: PlatformSmsGroup | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'registration', label: 'Registration' },
  { value: 'billing', label: 'Invoice & billing' },
  { value: 'promotional', label: 'Promotional' },
  { value: 'security', label: 'Login & security' },
];

export function LogTab({ initialStatus, onSendTest }: { initialStatus?: SmsMessageStatus; onSendTest: () => void }) {
  const toast = useToast();
  const [filters, setFilters] = useState<LogFilterState>(() => defaultLogFilters(new Date(), initialStatus ?? 'all'));
  const q = useDebounced(filters.q, 300);
  const effective = { ...filters, q };
  const resetKey = JSON.stringify(effective);
  const pages = useCursorPages(resetKey);
  const query = toLogQuery(effective, pages.cursor);
  const list = useQuery({ queryKey: platformSmsKeys.messages(query), queryFn: () => api.admin.platformSms.messages(query), placeholderData: keepPreviousData });
  const exportCsv = useMutation({
    mutationFn: () => api.admin.platformSms.exportMessages(toLogQuery(effective)),
    onSuccess: (file) => {
      saveBlob(file.blob, file.filename);
      toast('CSV downloaded · phones masked, codes hidden');
    },
    onError: (e) => toast(smsErrorText(e), 'danger'),
  });
  const set = (patch: Partial<LogFilterState>) => setFilters((f) => ({ ...f, ...patch }));
  const defaults = defaultLogFilters();
  const filtered = filters.q.trim() !== '' || filters.status !== 'all' || filters.group !== 'all' || filters.from !== defaults.from || filters.to !== defaults.to;
  const minDay = dhakaDaysAgo(90);

  return (
    <SectionCard
      title="Platform SMS log"
      description="Every SMS Storeplix sent to merchants in the last 90 days. Bangladesh time. Sign-in and verification codes are never shown."
      actions={
        <Button size="sm" variant="secondary" leftIcon={<Download aria-hidden className="size-3.5" />} loading={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
          Export CSV
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-[1fr_160px_150px_150px]">
          <Input aria-label="Search phone or shop" placeholder="Phone number or shop" leading={<Search aria-hidden className="size-4" />} leadingDivider={false} value={filters.q} onChange={(e) => set({ q: e.target.value })} />
          <Select aria-label="Status" value={filters.status} onChange={(e) => set({ status: e.target.value as LogFilterState['status'] })}>
            <option value="all">Status: All</option>
            <option value="sent">Sent</option>
            <option value="queued">Queued</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
          </Select>
          <Input aria-label="From date" type="date" min={minDay} max={filters.to || undefined} value={filters.from} onChange={(e) => set({ from: e.target.value })} />
          <Input aria-label="To date" type="date" min={filters.from || minDay} value={filters.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <div role="group" aria-label="Type" className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-text-muted">Type</span>
          {TYPE_CHIPS.map((c) => (
            <Chip key={c.value} selected={filters.group === c.value} check={false} onClick={() => set({ group: c.value })}>
              {c.label}
            </Chip>
          ))}
        </div>
      </div>

      {list.isPending ? (
        <LoadingRows label="Loading SMS log" rows={8} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.data.length === 0 ? (
        filtered || pages.page > 1 ? (
          <Empty
            icon={<SearchX />}
            title="No messages match these filters"
            description="Try another phone number, type or a wider date range."
            action={
              <Button variant="secondary" size="sm" onClick={() => setFilters(defaultLogFilters())}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <Empty
            icon={<MessageSquare />}
            title="No platform SMS yet"
            description="Messages show up here when Storeplix texts a merchant. Send a test from the Provider tab."
            action={
              <Button variant="secondary" size="sm" onClick={onSendTest}>
                Send test SMS
              </Button>
            }
          />
        )
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-default">
          <table className="w-full text-left text-body max-md:hidden">
            <thead className="bg-surface-subtle text-caption text-text-muted">
              <tr>
                {['TIME', 'PHONE', 'MERCHANT', 'TYPE', 'MESSAGE', 'PARTS', 'STATUS'].map((h) => (
                  <th key={h} className="px-3 py-2.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((m) => (
                <tr key={m.id} className="border-t border-border-default">
                  <td className="px-3 py-3 whitespace-nowrap text-text-secondary">{relativeDay(m.created_at)}</td>
                  <td className="px-3 py-3 font-medium whitespace-nowrap text-text-primary">{m.to_masked}</td>
                  <td className="px-3 py-3 text-text-primary">{m.merchant?.name ?? '—'}</td>
                  <td className="px-3 py-3">
                    <TypePill m={m} />
                  </td>
                  <td className="max-w-[280px] px-3 py-3">
                    <MessageCell m={m} />
                  </td>
                  <td className="px-3 py-3 text-text-primary">{m.parts ?? '—'}</td>
                  <td className="px-3 py-3">
                    <StatusPill m={m} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="flex flex-col divide-y divide-border-default md:hidden">
            {list.data.data.map((m) => (
              <li key={m.id} className="flex flex-col gap-1.5 p-3">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-body font-medium text-text-primary">{m.to_masked}</span>
                  <StatusPill m={m} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
                  <TypePill m={m} />
                  {m.merchant?.name ?? '—'} · {relativeDay(m.created_at)}
                  {m.parts ? ` · ${m.parts} parts` : ''}
                </div>
                <MessageCell m={m} />
              </li>
            ))}
          </ul>
          <CursorFooter page={pages.page} count={list.data.data.length} hasNext={!!list.data.meta.next_cursor} onPrev={pages.prev} onNext={() => list.data.meta.next_cursor && pages.next(list.data.meta.next_cursor)} />
        </div>
      )}
    </SectionCard>
  );
}

function TypePill({ m }: { m: PlatformSmsLogEntry }) {
  if (!m.group) return <Badge size="sm">{typeLabel(m.type)}</Badge>;
  return (
    <Badge size="sm" tone={groupTone[m.group]} title={typeLabel(m.type)}>
      {m.type === 'test' ? 'Test' : groupShortLabel[m.group]}
    </Badge>
  );
}

function MessageCell({ m }: { m: PlatformSmsLogEntry }) {
  if (m.body_hidden)
    return (
      <span className="inline-flex items-center gap-1.5 text-text-muted" data-testid="code-hidden">
        <Lock aria-hidden className="size-3.5" /> Code hidden
      </span>
    );
  return <span className={cn('block truncate', m.body_preview ? 'text-text-secondary' : 'text-text-muted')}>{m.body_preview ?? 'Text removed after 90 days'}</span>;
}

function StatusPill({ m }: { m: PlatformSmsLogEntry }) {
  const s = logStatusMeta[m.status];
  const title = [m.provider ? `Provider: ${m.provider.name}` : null, m.error_code ? `Error: ${m.error_code}` : null].filter(Boolean).join(' · ');
  return (
    <Badge size="sm" tone={s.tone} title={title || undefined}>
      {s.label}
    </Badge>
  );
}
