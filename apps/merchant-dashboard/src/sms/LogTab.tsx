import { isApiError } from '@storeplix/api-client';
import type { SmsLogEntry, SmsLogFilters, SmsMessageStatus } from '@storeplix/types';
import { SMS_LOG_PER_PAGE } from '@storeplix/types';
import { Badge, Button, Chip, cn, EmptyState, Select } from '@storeplix/ui';
import { ChevronLeft, ChevronRight, MessageCircle, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults } from '../catalog/states';
import { normalizeBdPhone } from '../lib/phone';
import { Panel } from './components';
import { useSmsLog } from './queries';
import { chargedLabel, logDateBounds, logMessage, logStatusMeta, logTime, LOG_STATUS_OPTIONS, PURPOSE_CHIPS, purposesFor, purposeTag, referenceHref, timeZoneName, type PurposeChip } from './sms';

// Figma SMS log 2075:51037 (mobile 2081:1561), §12.4: phone search (exact), status, date range (≤ 90 days back),
// purpose chips, cursor pagination (Previous / Next) instead of numbered pages. Phones are masked by the API; checkout
// codes are never shown.

export const PHONE_ERROR = 'Enter a full phone number';

export function LogTab({ canSendTest, onSendTest }: { canSendTest: boolean; onSendTest: () => void }) {
  const { store } = useStoreScope();
  const tz = store?.timezone;
  const bounds = useMemo(() => logDateBounds(), []);
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [status, setStatus] = useState<'' | SmsMessageStatus>('');
  const [from, setFrom] = useState(bounds.from);
  const [to, setTo] = useState(bounds.to);
  const [chip, setChip] = useState<PurposeChip>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [sawTest, setSawTest] = useState(false);

  const filters: SmsLogFilters = useMemo(
    () => ({ purpose: purposesFor(chip), status: status ? [status] : undefined, from: from || undefined, to: to || undefined, phone: phone || undefined, cursor }),
    [chip, status, from, to, phone, cursor],
  );
  const log = useSmsLog(filters);
  const rows = log.data?.data ?? [];
  const meta = log.data?.meta;
  if (!sawTest && rows.some((r) => r.purpose === 'sms_test')) setSawTest(true);
  const filtered = chip !== 'all' || !!status || !!phone || from !== bounds.from || to !== bounds.to;
  const serverPhoneError = isApiError(log.error) && log.error.status === 422 && Object.keys(log.error.fieldErrors ?? {}).some((k) => k.includes('phone'));

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    setCursor(undefined);
    set(v);
  };
  const applyPhone = () => {
    const raw = phoneInput.trim();
    if (!raw) {
      setPhoneError(null);
      if (phone) reset(setPhone)('');
      return;
    }
    const n = normalizeBdPhone(raw);
    if (!n) {
      setPhoneError(PHONE_ERROR);
      return;
    }
    setPhoneError(null);
    if (n !== phone) reset(setPhone)(n);
  };
  const clear = () => {
    setPhoneInput('');
    setPhone('');
    setPhoneError(null);
    setStatus('');
    setFrom(bounds.from);
    setTo(bounds.to);
    setChip('all');
    setCursor(undefined);
  };
  const chips = PURPOSE_CHIPS.filter((c) => c.value !== 'test' || sawTest || chip === 'test');

  return (
    <Panel title="SMS log" description={`Every SMS your shop sent in the last 90 days. Times are ${timeZoneName(tz)} time.`}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label className={cn('flex h-10 items-center gap-2 rounded-control border bg-surface-card px-3 focus-within:border-brand-600', phoneError || serverPhoneError ? 'border-danger' : 'border-border-default')}>
            <Search aria-hidden className="size-4 shrink-0 text-text-muted" />
            <input
              type="search"
              inputMode="tel"
              aria-label="Search by phone number"
              placeholder="Search by phone number"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              onBlur={applyPhone}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyPhone();
              }}
              className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
          {(phoneError || serverPhoneError) && <p className="text-caption text-danger">{PHONE_ERROR}</p>}
        </div>
        <Select aria-label="Status" containerClassName="md:w-40" value={status} onChange={(e) => reset(setStatus)(e.target.value as '' | SmsMessageStatus)}>
          {LOG_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Status: {o.label}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2">
          <input
            type="date"
            aria-label="From"
            min={bounds.min}
            max={to || bounds.to}
            value={from}
            onChange={(e) => reset(setFrom)(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-control border border-border-default bg-surface-card px-2 text-body text-text-primary outline-none focus:border-brand-600"
          />
          <span className="text-text-muted">–</span>
          <input
            type="date"
            aria-label="To"
            min={from || bounds.min}
            max={bounds.to}
            value={to}
            onChange={(e) => reset(setTo)(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-control border border-border-default bg-surface-card px-2 text-body text-text-primary outline-none focus:border-brand-600"
          />
        </div>
      </div>
      <div role="group" aria-label="Purpose" className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <span className="hidden text-caption text-text-secondary sm:inline">Purpose</span>
        {chips.map((c) => (
          <Chip key={c.value} selected={chip === c.value} check={false} className="shrink-0" onClick={() => reset(setChip)(c.value)}>
            {c.label}
          </Chip>
        ))}
      </div>

      {log.isPending ? (
        <LoadingRows rows={6} label="Loading SMS log" />
      ) : log.isError && !serverPhoneError ? (
        <ErrorBlock title="We couldn’t load the SMS log" error={log.error} onRetry={() => void log.refetch()} />
      ) : rows.length === 0 ? (
        filtered ? (
          <NoResults title="No messages match these filters" description="Try another phone number or a wider date range." onClear={clear} clearLabel="Clear filters" />
        ) : (
          <EmptyState
            icon={<MessageCircle aria-hidden />}
            title="No SMS sent yet"
            description="Messages show up here as soon as your shop sends one. Send a test SMS to your phone to try it."
            action={
              canSendTest ? (
                <Button size="sm" variant="secondary" onClick={onSendTest}>
                  Send test SMS
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-card border border-border-default md:block">
            <table className="w-full text-left text-body" aria-label="SMS log">
              <thead className="bg-surface-subtle text-caption text-text-muted uppercase">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Time</th>
                  <th className="px-3 py-2.5 font-medium">Phone</th>
                  <th className="px-3 py-2.5 font-medium">Purpose</th>
                  <th className="px-3 py-2.5 font-medium">Message</th>
                  <th className="px-3 py-2.5 font-medium">Parts</th>
                  <th className="px-3 py-2.5 font-medium">Charged from</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <LogRow key={r.id} entry={r} tz={tz} />
                ))}
              </tbody>
            </table>
          </div>
          <ul aria-label="SMS log" className="flex flex-col gap-2 md:hidden">
            {rows.map((r) => (
              <LogCard key={r.id} entry={r} tz={tz} />
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <p className="flex-1 text-caption text-text-secondary">Showing {SMS_LOG_PER_PAGE} per page</p>
            <Button size="sm" variant="secondary" aria-label="Previous page" disabled={!meta?.prev_cursor || log.isFetching} onClick={() => setCursor(meta?.prev_cursor ?? undefined)} leftIcon={<ChevronLeft aria-hidden className="size-4" />}>
              Previous
            </Button>
            <Button size="sm" variant="secondary" aria-label="Next page" disabled={!meta?.next_cursor || log.isFetching} onClick={() => setCursor(meta?.next_cursor ?? undefined)}>
              Next
              <ChevronRight aria-hidden className="size-4" />
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}

function Reference({ entry }: { entry: SmsLogEntry }) {
  const href = referenceHref(entry.reference);
  if (!href || !entry.reference) return null;
  return (
    <Link to={href} className="text-caption font-medium text-brand-600 hover:underline">
      {entry.reference.label}
    </Link>
  );
}

function StatusCell({ entry }: { entry: SmsLogEntry }) {
  const st = logStatusMeta(entry);
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Badge tone={st.tone} dot size="sm">
        {st.label}
      </Badge>
      {st.sub && <span className="text-caption text-text-muted">{st.sub}</span>}
    </span>
  );
}

function LogRow({ entry, tz }: { entry: SmsLogEntry; tz: string | undefined }) {
  const tag = purposeTag(entry.purpose);
  const msg = logMessage(entry);
  return (
    <tr className="border-t border-border-default align-middle">
      <td className="px-3 py-3 whitespace-nowrap text-text-primary">{logTime(entry.created_at, tz)}</td>
      <td className="px-3 py-3 whitespace-nowrap text-text-primary">{entry.to_masked}</td>
      <td className="px-3 py-3">
        <span className="flex flex-col items-start gap-0.5">
          <Badge tone={tag.tone} size="sm">
            {tag.label}
          </Badge>
          <Reference entry={entry} />
        </span>
      </td>
      <td className="max-w-[320px] px-3 py-3">
        <span className={cn('block truncate', msg.muted ? 'text-text-muted' : 'font-bangla text-text-secondary')} title={msg.muted ? undefined : msg.text}>
          {msg.text}
        </span>
      </td>
      <td className="px-3 py-3 text-text-primary">{entry.parts ?? '—'}</td>
      <td className="px-3 py-3 text-text-secondary">{chargedLabel(entry.charged_from)}</td>
      <td className="px-3 py-3">
        <StatusCell entry={entry} />
      </td>
    </tr>
  );
}

function LogCard({ entry, tz }: { entry: SmsLogEntry; tz: string | undefined }) {
  const tag = purposeTag(entry.purpose);
  const msg = logMessage(entry);
  const st = logStatusMeta(entry);
  return (
    <li className="flex flex-col gap-1.5 rounded-card border border-border-default px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-body font-medium text-text-primary">{entry.to_masked}</span>
        <Badge tone={st.tone} dot size="sm">
          {st.label}
        </Badge>
      </div>
      <p className={cn('line-clamp-2 text-body', msg.muted ? 'text-text-muted' : 'font-bangla text-text-secondary')}>{msg.text}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-muted">
        <Badge tone={tag.tone} size="sm">
          {tag.label}
        </Badge>
        <span>{logTime(entry.created_at, tz)}</span>
        {entry.parts !== null && <span>· {entry.parts} {entry.parts === 1 ? 'part' : 'parts'}</span>}
        {entry.charged_from && <span>· {chargedLabel(entry.charged_from)}</span>}
        {st.sub && <span>· {st.sub}</span>}
        <Reference entry={entry} />
      </div>
    </li>
  );
}
