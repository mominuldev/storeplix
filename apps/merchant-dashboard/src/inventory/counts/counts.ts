import { isApiError } from '@storeplix/api-client';
import {
  STOCK_COUNT_CODE_MAX,
  STOCK_COUNT_COUNTED_MAX,
  STOCK_COUNT_NAME_MAX,
  STOCK_COUNT_STATUS_LABELS,
  type FinishStockCountInput,
  type ScanStockCountInput,
  type SetStockCountLineInput,
  type StartStockCountInput,
  type StockCount,
  type StockCountDetail,
  type StockCountLine,
  type StockCountLineFilters,
  type StockCountLineListMeta,
  type StockCountLineResult,
  type StockCountListFilters,
  type StockCountStatus,
  type StockCountSummary,
} from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { formatBdt, formatCount, plural } from '../../catalog/format';
import { keys, useStoreScope } from '../../catalog/scope';
import { errorMessage } from '../../catalog/states';
import { api } from '../../lib/api';

// PHASE-8-8C part B §8 / §10.5: stock count helpers, copy and queries (Figma 153:35246).

type Scope = { tenantId: string | null; storeId: string | null };

export const countKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'stock-counts'] as const,
  list: (s: Scope, f: StockCountListFilters) => [s.tenantId, s.storeId, 'stock-counts', 'list', f] as const,
  detail: (s: Scope, id: string | undefined) => [s.tenantId, s.storeId, 'stock-counts', 'detail', id] as const,
  linesOf: (s: Scope, id: string | undefined) => [s.tenantId, s.storeId, 'stock-counts', 'lines', id] as const,
  lines: (s: Scope, id: string | undefined, f: StockCountLineFilters) => [s.tenantId, s.storeId, 'stock-counts', 'lines', id, f] as const,
};

const statusTone: Record<StockCountStatus, BadgeTone> = { in_progress: 'info', completed: 'success', cancelled: 'neutral' };
export const countPill = (s: StockCountStatus) => ({ label: STOCK_COUNT_STATUS_LABELS[s], tone: statusTone[s] });

export function countProgress(c: Pick<StockCount, 'counted_count' | 'lines_count'>) {
  const pct = c.lines_count > 0 ? Math.round((c.counted_count / c.lines_count) * 100) : 0;
  return { pct, text: `${formatCount(c.counted_count)} of ${plural(c.lines_count, 'variant')} counted` };
}

/** EXPECTED column: stored at count time; before that the location's current on hand. */
export const lineExpected = (l: Pick<StockCountLine, 'expected' | 'on_hand'>) => l.expected ?? l.on_hand;

/** DIFFERENCE pill: "−2" (danger), "+1" (info), "Match" (success); null while not counted. */
export function differencePill(l: Pick<StockCountLine, 'counted' | 'difference'>): { label: string; tone: BadgeTone } | null {
  if (l.counted === null || l.difference === null) return null;
  if (l.difference === 0) return { label: 'Match', tone: 'success' };
  return l.difference > 0 ? { label: `+${formatCount(l.difference)}`, tone: 'info' } : { label: `−${formatCount(-l.difference)}`, tone: 'danger' };
}

/** Signed money "− ৳ 6,900" / "+ ৳ 1,850"; null → "—". */
export function signedMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || amount === 0) return '—';
  return `${amount < 0 ? '−' : '+'} ${formatBdt(Math.abs(amount))}`;
}

/** "If you finish now" lines (153:35960). Values only with `costs.view` (amounts are null otherwise). */
export function summaryLines(s: StockCountSummary, withValues: boolean) {
  const v = (units: number, amount: number | null, one = 'item') => [plural(units, one), withValues && amount !== null ? formatBdt(amount) : null].filter(Boolean).join(' · ');
  const net = s.net_value_amount;
  return {
    short: v(s.short_units, s.short_value_amount),
    extra: v(s.extra_units, s.extra_value_amount),
    notCounted: plural(s.not_counted, 'variant'),
    net: withValues && net !== null ? { label: net < 0 ? 'Net stock loss' : net > 0 ? 'Net stock gain' : 'Net change', value: net === 0 ? formatBdt(0) : signedMoney(net), tone: net < 0 ? 'danger' : net > 0 ? 'info' : 'neutral' } : null,
  };
}

// ---------- Start ----------

export const startCountSchema = z.object({
  location_id: z.string().min(1, 'Choose a location.'),
  category_id: z.string(),
  name: z.string().trim().max(STOCK_COUNT_NAME_MAX, `Keep the name under ${STOCK_COUNT_NAME_MAX} characters.`),
});
export type StartCountValues = z.input<typeof startCountSchema>;

export const startInputOf = (v: StartCountValues): StartStockCountInput => ({ location_id: v.location_id, category_id: v.category_id || null, name: v.name.trim() || null });

/** Placeholder of the name field: the API default "Count {d M} · {location}". */
export function defaultCountName(locationName: string | undefined, now = new Date()): string {
  return `Count ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${locationName ? ` · ${locationName}` : ''}`;
}

// ---------- Scan / set ----------

/** Trimmed code, or null when empty / too long. */
export function scanCode(raw: string): string | null {
  const c = raw.trim();
  return c && c.length <= STOCK_COUNT_CODE_MAX ? c : null;
}

/** COUNTED editor: integer 0–1,000,000; empty = un-count (null); invalid = undefined. */
export function parseCounted(raw: string): number | null | undefined {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n <= STOCK_COUNT_COUNTED_MAX ? n : undefined;
}

// ---------- Errors ----------

export function countError(e: unknown, fallback: string): string {
  if (isApiError(e)) {
    if (e.code === 'count_line_not_found') {
      const code = (e.details as Record<string, unknown> | undefined)?.code;
      return `No product in this count has the SKU or barcode “${typeof code === 'string' ? code : ''}”.`;
    }
    if (e.code === 'count_in_progress') return 'A count is already in progress at this location.';
    if (e.code === 'count_too_large') return 'This count would have more than 5,000 products. Pick a category to count in parts.';
    if (e.code === 'revision_mismatch' || e.code === 'revision_conflict') return 'Someone else changed this count. Reload and try again.';
    if (e.code === 'invalid_state_transition') return 'This count is already finished or cancelled. Reload to see it.';
    if (e.code === 'location_archived') return 'This location is archived.';
    if (e.status === 422) return e.fieldErrors ? (Object.values(e.fieldErrors)[0]?.[0] ?? e.message) : e.message || fallback;
  }
  return errorMessage(e, fallback);
}

/** `details.count_id` of 409 `count_in_progress`. */
export function openCountId(e: unknown): string | null {
  if (!isApiError(e) || e.code !== 'count_in_progress') return null;
  const id = (e.details as Record<string, unknown> | undefined)?.count_id;
  return typeof id === 'string' ? id : null;
}

// ---------- Queries ----------

export function useCounts(filters: StockCountListFilters) {
  const s = useStoreScope();
  return useQuery({ queryKey: countKeys.list(s, filters), queryFn: () => api.stockCounts.list(s.storeId!, filters), enabled: !!s.storeId, retry: false, placeholderData: keepPreviousData });
}

export function useCount(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: countKeys.detail(s, id), queryFn: () => api.stockCounts.get(s.storeId!, id!), enabled: !!s.storeId && !!id, retry: false });
}

export function useCountLines(id: string | undefined, filters: StockCountLineFilters) {
  const s = useStoreScope();
  return useQuery({
    queryKey: countKeys.lines(s, id, filters),
    queryFn: () => api.stockCounts.lines(s.storeId!, id!, filters),
    enabled: !!s.storeId && !!id,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

type LinesPage = { data: StockCountLine[]; meta: StockCountLineListMeta };

/** Patch the count header/summary and every cached lines page from a scan / set result (no refetch). */
export function applyLineResult(qc: QueryClient, s: Scope, id: string, r: StockCountLineResult) {
  qc.setQueryData<StockCountDetail>(countKeys.detail(s, id), (old) => (old ? { ...old, ...r.count, summary: r.summary } : old));
  qc.setQueriesData<LinesPage>({ queryKey: countKeys.linesOf(s, id) }, (old) =>
    old
      ? {
          data: old.data.map((l) => (l.id === r.line.id ? r.line : l)),
          meta: { ...old.meta, counts: { all: r.count.lines_count, not_counted: r.summary.not_counted, differences: r.summary.differences, matched: r.summary.matched } },
        }
      : old,
  );
}

function invalidateAfterFinish(qc: QueryClient, s: Scope) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: countKeys.all(s) }),
    qc.invalidateQueries({ queryKey: keys.inventory(s) }),
    qc.invalidateQueries({ queryKey: keys.movements(s) }),
    qc.invalidateQueries({ queryKey: keys.products(s) }),
    qc.invalidateQueries({ queryKey: [s.tenantId, s.storeId, 'product'] }),
    qc.invalidateQueries({ queryKey: keys.dashboard(s) }),
    qc.invalidateQueries({ queryKey: [s.tenantId, s.storeId, 'locations'] }),
  ]);
}

export function useCountMutations(id?: string) {
  const s = useStoreScope();
  const qc = useQueryClient();
  const sid = () => s.storeId!;
  return {
    start: useMutation({ mutationFn: (input: StartStockCountInput) => api.stockCounts.start(sid(), input), onSuccess: () => qc.invalidateQueries({ queryKey: countKeys.all(s) }) }),
    scan: useMutation({ mutationFn: (input: ScanStockCountInput) => api.stockCounts.scan(sid(), id!, input), onSuccess: (r) => applyLineResult(qc, s, id!, r) }),
    setLine: useMutation({ mutationFn: ({ lineId, input }: { lineId: string; input: SetStockCountLineInput }) => api.stockCounts.setLine(sid(), id!, lineId, input), onSuccess: (r) => applyLineResult(qc, s, id!, r) }),
    finish: useMutation({ mutationFn: ({ input, key }: { input: FinishStockCountInput; key: string }) => api.stockCounts.finish(sid(), id!, input, key), onSuccess: () => invalidateAfterFinish(qc, s) }),
    cancel: useMutation({ mutationFn: (revision?: number) => api.stockCounts.cancel(sid(), id!, { revision }), onSuccess: () => qc.invalidateQueries({ queryKey: countKeys.all(s) }) }),
  };
}
