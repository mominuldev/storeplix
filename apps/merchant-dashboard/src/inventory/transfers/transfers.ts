import { isApiError } from '@storeplix/api-client';
import {
  STOCK_TRANSFER_LINES_MAX,
  STOCK_TRANSFER_QUANTITY_MAX,
  STOCK_TRANSFER_STATUS_LABELS,
  type CreateStockTransferInput,
  type InventoryItem,
  type ReceiveStockTransferInput,
  type StockMovement,
  type StockTransfer,
  type StockTransferDetail,
  type StockTransferListFilters,
  type StockTransferStatus,
  type UpdateStockTransferInput,
} from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { formatCount } from '../../catalog/format';
import { keys, useStoreScope } from '../../catalog/scope';
import { errorMessage } from '../../catalog/states';
import { api } from '../../lib/api';
import { handlePlanLimit } from '../../plan/Banners';
import { stockAt } from '../locations';

// PHASE-8-8C part B §7 / §10.4: stock transfer helpers, copy and queries (Figma 153:34425). Pure helpers are unit-tested
// in phase8-8c-b.test.tsx.

type Scope = { tenantId: string | null; storeId: string | null };

export const transferKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'stock-transfers'] as const,
  list: (s: Scope, f: StockTransferListFilters) => [s.tenantId, s.storeId, 'stock-transfers', 'list', f] as const,
  summary: (s: Scope) => [s.tenantId, s.storeId, 'stock-transfers', 'summary'] as const,
  detail: (s: Scope, id: string | null | undefined) => [s.tenantId, s.storeId, 'stock-transfers', 'detail', id] as const,
};

// ---------- Status ----------

/** Chips (153:35085): All / Draft / In transit / Received, + Cancelled (composed). */
export const TRANSFER_CHIPS = ['all', 'draft', 'in_transit', 'received', 'cancelled'] as const;
export type TransferChip = (typeof TRANSFER_CHIPS)[number];

const statusTone: Record<StockTransferStatus, BadgeTone> = { draft: 'neutral', in_transit: 'info', received: 'success', cancelled: 'neutral' };

/** Pill: Draft (neutral), In transit (info), Received (success), "Received · n short" (danger), Cancelled (neutral). */
export function transferPill(t: Pick<StockTransfer, 'status' | 'units_short'>): { label: string; tone: BadgeTone } {
  if (t.status === 'received' && t.units_short > 0) return { label: `Received · ${formatCount(t.units_short)} short`, tone: 'danger' };
  return { label: STOCK_TRANSFER_STATUS_LABELS[t.status], tone: statusTone[t.status] };
}

/** DATE column: sent, else created — "Today", "Yesterday", "19 Nov". */
export function transferDate(t: Pick<StockTransfer, 'sent_at' | 'created_at'>, now = new Date()): string {
  return dayLabel(t.sent_at ?? t.created_at, now);
}

export function dayLabel(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** KPI "In transit" sub: "24 items · sent yesterday". */
export function sentRelative(iso: string | null | undefined, now = new Date()): string {
  const label = dayLabel(iso, now);
  if (!label) return '';
  return label === 'Today' ? 'sent today' : label === 'Yesterday' ? 'sent yesterday' : `sent ${label}`;
}

// ---------- Panel lines ----------

/** One line in the panel draft. `item` is set for lines picked in this session (has per-location numbers). */
export interface DraftLine {
  variant_id: string;
  name: string;
  variant: string | null;
  quantity: number | null;
  /** saved line: source numbers as of the saved From location */
  saved?: { from_id: string; on_hand: number; available: number; threshold: number | null };
  item?: InventoryItem;
}

export const variantText = (title: string) => (title && title !== 'Default' ? title : null);

export function draftLineFromItem(i: InventoryItem): DraftLine {
  return { variant_id: i.variant_id, name: i.product.name, variant: variantText(i.title), quantity: 1, item: i };
}

export function draftLinesOf(t: StockTransferDetail): DraftLine[] {
  return t.lines.map((l) => ({
    variant_id: l.variant.id,
    name: l.variant.product.name,
    variant: variantText(l.variant.title),
    quantity: l.quantity,
    saved: { from_id: t.from_location.id, on_hand: l.source_on_hand, available: l.source_available, threshold: l.source_low_stock_threshold },
  }));
}

/** Source numbers of a draft line at `fromId` (null when unknown: a saved line after From changed). */
export function sourceOf(line: DraftLine, fromId: string): { on_hand: number; available: number; threshold: number | null } | null {
  if (line.item) {
    const s = stockAt(line.item, fromId);
    return { on_hand: s.on_hand, available: s.available, threshold: line.item.low_stock_threshold ?? line.item.effective_threshold };
  }
  if (line.saved && line.saved.from_id === fromId) return { on_hand: line.saved.on_hand, available: line.saved.available, threshold: line.saved.threshold };
  return null;
}

/**
 * "{From} stock a → b" (153:35223). Red when b is at or below the source threshold (no threshold: below 0 never
 * happens on send, so 0 counts as low). `over` = more than the source's available (send would fail, P88C-10).
 */
export function stockPreview(fromName: string, source: { on_hand: number; available: number; threshold: number | null } | null, quantity: number | null) {
  if (!source) return null;
  const q = quantity ?? 0;
  const after = source.on_hand - q;
  const low = after <= (source.threshold ?? 0);
  return { text: `${fromName} stock ${formatCount(source.on_hand)} → ${formatCount(after)}`, after, low, over: q > source.available };
}

/** Warning card (153:35235) for the lines that drop the source to its low-stock level (P88C-10). */
export function lowStockWarning(lines: { name: string; after: number; low: boolean }[], fromName: string, fromIsOnline: boolean): string | null {
  const low = lines.filter((l) => l.low);
  if (low.length === 0) return null;
  const tail = fromIsOnline ? ' — online orders may sell out.' : '.';
  if (low.length === 1) return `${low[0]!.name} will drop to ${formatCount(low[0]!.after)} in ${fromName}${tail}`;
  return `${formatCount(low.length)} products will drop to their low-stock level in ${fromName}${tail}`;
}

/** Client checks before Save draft / Send. Returns the first problem as copy, or null. */
export function draftProblem(v: { from: string; to: string; lines: DraftLine[] }): string | null {
  if (!v.from || !v.to) return 'Choose where the stock comes from and where it goes.';
  if (v.from === v.to) return 'From and To must be different locations.';
  if (v.lines.length === 0) return 'Add at least one product.';
  if (v.lines.length > STOCK_TRANSFER_LINES_MAX) return `A transfer can have up to ${STOCK_TRANSFER_LINES_MAX} products.`;
  if (v.lines.some((l) => !l.quantity || l.quantity < 1 || l.quantity > STOCK_TRANSFER_QUANTITY_MAX || !Number.isInteger(l.quantity))) return 'Enter a quantity of at least 1 for every product.';
  return null;
}

export function transferInputOf(v: { from: string; to: string; note: string; lines: DraftLine[] }): CreateStockTransferInput {
  return {
    from_location_id: v.from,
    to_location_id: v.to,
    note: v.note.trim() || null,
    lines: v.lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity ?? 0 })),
  };
}

// ---------- Receive ----------

export type ReceiveDraft = Record<string, number | null>;

export const receiveAllDraft = (t: Pick<StockTransferDetail, 'lines'>): ReceiveDraft => Object.fromEntries(t.lines.map((l) => [l.id, l.quantity]));

/** Live "n short" while receiving: Σ (quantity − received); empty inputs count as 0 received. */
export function receiveTotals(t: Pick<StockTransferDetail, 'lines'>, draft: ReceiveDraft) {
  let received = 0;
  let short = 0;
  let invalid = false;
  for (const l of t.lines) {
    const r = draft[l.id] ?? 0;
    if (r < 0 || r > l.quantity || !Number.isInteger(r)) invalid = true;
    const clamped = Math.min(Math.max(r, 0), l.quantity);
    received += clamped;
    short += l.quantity - clamped;
  }
  return { received, short, invalid };
}

export function receiveInputOf(t: StockTransferDetail, draft: ReceiveDraft): ReceiveStockTransferInput {
  return { revision: t.revision, lines: t.lines.map((l) => ({ item_id: l.id, received: draft[l.id] ?? 0 })) };
}

// ---------- Errors ----------

/** Transfer write errors → copy. A 402 opens the plan dialog and returns null. */
export function transferError(e: unknown, fallback: string): string | null {
  if (handlePlanLimit(e)) return null;
  if (isApiError(e)) {
    if (e.code === 'insufficient_stock') return 'Not enough stock at the source for some products. Lower the quantities or adjust stock first.';
    if (e.code === 'revision_mismatch' || e.code === 'revision_conflict') return 'This transfer was changed by someone else. Reload and try again.';
    if (e.code === 'invalid_state_transition') return 'This transfer has moved on. Reload to see its current status.';
    if (e.code === 'location_archived') return 'One of the locations is archived. Choose another one.';
    if (e.status === 422) return e.fieldErrors ? (Object.values(e.fieldErrors)[0]?.[0] ?? e.message) : e.message || fallback;
  }
  return errorMessage(e, fallback);
}

/** Variant ids over the source's available from a 422 `insufficient_stock` (`details.lines`). */
export function insufficientLines(e: unknown): { variant_id: string; available: number }[] {
  if (!isApiError(e) || e.code !== 'insufficient_stock') return [];
  const raw = (e.details as Record<string, unknown> | undefined)?.lines;
  return Array.isArray(raw)
    ? raw.filter((r): r is { variant_id: string; available: number } => !!r && typeof r === 'object' && typeof (r as { variant_id?: unknown }).variant_id === 'string')
    : [];
}

// ---------- Movement rows (§10.1) ----------

/**
 * "Transfer → Dhanmondi shop" / "Count · Monthly count". The API writes the transfer note "TR-021 → Dhanmondi shop"
 * (§7) and the count name as the count movement note.
 */
export function movementRefLabel(m: Pick<StockMovement, 'reason' | 'reference' | 'note'>): { label: string; sub: string | null; to: string | null } | null {
  if (m.reference?.type === 'stock_transfer') {
    const note = m.note ?? '';
    const [number, dest] = note.split(' → ');
    const cancelled = /cancel/i.test(note);
    return {
      label: cancelled ? 'Transfer cancelled' : dest ? `Transfer → ${dest.trim()}` : m.reason === 'transfer_out' ? 'Transfer out' : 'Transfer in',
      sub: number?.trim() || null,
      to: `/inventory/transfers/${m.reference.id}`,
    };
  }
  if (m.reference?.type === 'stock_count' || m.reason === 'count') {
    return { label: m.note ? `Count · ${m.note}` : 'Stock count', sub: null, to: m.reference ? `/inventory/counts/${m.reference.id}` : null };
  }
  return null;
}

// ---------- Queries ----------

export function invalidateTransfers(qc: QueryClient, s: Scope, stock: boolean) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: transferKeys.all(s) }),
    ...(stock
      ? [
          qc.invalidateQueries({ queryKey: keys.inventory(s) }),
          qc.invalidateQueries({ queryKey: keys.movements(s) }),
          qc.invalidateQueries({ queryKey: keys.products(s) }),
          qc.invalidateQueries({ queryKey: [s.tenantId, s.storeId, 'product'] }),
          qc.invalidateQueries({ queryKey: keys.dashboard(s) }),
          qc.invalidateQueries({ queryKey: [s.tenantId, s.storeId, 'locations'] }),
        ]
      : []),
  ]);
}

export function useTransfers(filters: StockTransferListFilters, enabled = true) {
  const s = useStoreScope();
  return useQuery({
    queryKey: transferKeys.list(s, filters),
    queryFn: () => api.stockTransfers.list(s.storeId!, filters),
    enabled: !!s.storeId && enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useTransferSummary(enabled = true) {
  const s = useStoreScope();
  return useQuery({ queryKey: transferKeys.summary(s), queryFn: () => api.stockTransfers.summary(s.storeId!), enabled: !!s.storeId && enabled, retry: false });
}

export function useTransfer(id: string | null | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: transferKeys.detail(s, id), queryFn: () => api.stockTransfers.get(s.storeId!, id!), enabled: !!s.storeId && !!id, retry: false });
}

export function useTransferMutations() {
  const s = useStoreScope();
  const qc = useQueryClient();
  const sid = () => s.storeId!;
  const plain = () => invalidateTransfers(qc, s, false);
  const stock = () => invalidateTransfers(qc, s, true);
  return {
    create: useMutation({
      mutationFn: ({ input, key }: { input: CreateStockTransferInput; key?: string }) => api.stockTransfers.create(sid(), input, key),
      onSuccess: (t) => (t.status === 'draft' ? plain() : stock()),
    }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateStockTransferInput }) => api.stockTransfers.update(sid(), id, input), onSuccess: plain }),
    remove: useMutation({ mutationFn: (id: string) => api.stockTransfers.delete(sid(), id), onSuccess: plain }),
    send: useMutation({ mutationFn: ({ id, key, revision }: { id: string; key: string; revision?: number }) => api.stockTransfers.send(sid(), id, key, { revision }), onSuccess: stock }),
    receive: useMutation({ mutationFn: ({ id, input, key }: { id: string; input: ReceiveStockTransferInput; key: string }) => api.stockTransfers.receive(sid(), id, input, key), onSuccess: stock }),
    cancel: useMutation({ mutationFn: ({ id, revision }: { id: string; revision?: number }) => api.stockTransfers.cancel(sid(), id, { revision }), onSuccess: stock }),
  };
}
