import type { AnalyticsGranularity, AnalyticsMeta, AnalyticsPlanRef, AnalyticsRange } from '@storeplix/types';
import type { ChartTone } from '@storeplix/ui';

// PHASE-8-2 §Conventions: money is paisa, rates are fractions in [0, 1]; days are Dhaka calendar dates (YYYY-MM-DD),
// timestamps are UTC ISO 8601 shown in Asia/Dhaka.

const TZ = 'Asia/Dhaka';

/** "2026-11-22" → a Date at UTC midnight, so formatting with timeZone UTC never shifts the calendar day. */
export function parseDay(day: string | null | undefined): Date | null {
  if (!day || !/^\d{4}-\d{2}(-\d{2})?$/.test(day)) return null;
  const [y, m, d = '01'] = day.split('-');
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

const dayFmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts });
// en-GB abbreviates September as "Sept"; Figma uses the three-letter form everywhere.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonthY = dayFmt({ month: 'long', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

const fmt = (f: Intl.DateTimeFormat, day: string | null | undefined) => {
  const d = parseDay(day);
  return d ? f.format(d) : '—';
};

const parts = (day: string | null | undefined) => {
  const d = parseDay(day);
  return d ? { d: d.getUTCDate(), m: MON[d.getUTCMonth()]!, y: d.getUTCFullYear() } : null;
};
/** "22 Nov" */
export const dayMonth = (day: string | null | undefined) => {
  const p = parts(day);
  return p ? `${p.d} ${p.m}` : '—';
};
/** "22 Nov 2026" */
export const dayMonthYear = (day: string | null | undefined) => {
  const p = parts(day);
  return p ? `${p.d} ${p.m} ${p.y}` : '—';
};
/** "Nov" */
export const monthShort = (day: string | null | undefined) => parts(day)?.m ?? '—';
/** "Nov 2026" (cohort labels, customer since) */
export const monthYear = (day: string | null | undefined) => {
  const p = parts(day);
  return p ? `${p.m} ${p.y}` : '—';
};
/** "November 2026" */
export const monthLong = (day: string | null | undefined) => fmt(fmtMonthY, day);

/** §7.1 caption: "Data as of 22 Nov · updated 00:24" (Dhaka). Null when there is no data yet. */
export function dataAsOf(meta: Pick<AnalyticsMeta, 'as_of' | 'computed_at'> | undefined): string | null {
  if (!meta?.as_of) return null;
  const at = meta.computed_at ? new Date(meta.computed_at) : null;
  const time = at && !Number.isNaN(at.getTime()) ? ` · updated ${fmtTime.format(at)}` : '';
  return `Data as of ${dayMonth(meta.as_of)}${time}`;
}

/** "History starts 1 Mar 2025" when the requested range begins before the first snapshot. */
export function historyNote(meta: AnalyticsMeta | undefined): string | null {
  if (!meta?.data_starts_on || !meta.from) return null;
  return meta.from < meta.data_starts_on ? `History starts ${dayMonthYear(meta.data_starts_on)}` : null;
}

/** Range subtitle: "December 2025 – November 2026" (month buckets) or "24 Oct – 22 Nov 2026". */
export function rangeLabel(meta: Pick<AnalyticsMeta, 'from' | 'to' | 'granularity'> | undefined): string {
  if (!meta) return '';
  if (meta.granularity === 'month') return `${monthLong(meta.from)} – ${monthLong(meta.to)}`;
  const sameYear = meta.from.slice(0, 4) === meta.to.slice(0, 4);
  return `${sameYear ? dayMonth(meta.from) : dayMonthYear(meta.from)} – ${dayMonthYear(meta.to)}`;
}

/** x labels: `MMM` for month buckets, `d MMM` for day/week (§7.1 MRR chart). */
export function bucketLabel(bucketStart: string, granularity: AnalyticsGranularity): string {
  return granularity === 'month' ? monthShort(bucketStart) : dayMonth(bucketStart);
}

const trim1 = (n: number) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, ''));

/** 0.2712 → "27%", 0.021 → "2.1%", null → "—". */
export function rate(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v < 0 ? '−' : ''}${trim1(Math.abs(v * 100))}%`;
}

export interface Delta {
  label: string;
  /** success tone when true, danger when false. */
  good: boolean;
}

/**
 * §7.1 delta pills: green ↑ / red ↓, hidden (null) when the previous value is null or 0, or nothing changed.
 * `ratio` → "↑ 11%", `points` (rates) → "↓ 0.4 pts", `count` → "↑ 214", `money` → "↑ ৳ 18" via `formatMoney`.
 * `higherIsBetter = false` for churn (down = green).
 */
export function delta(
  cur: number | null | undefined,
  prev: number | null | undefined,
  kind: 'ratio' | 'points' | 'count' | 'money',
  { higherIsBetter = true, formatMoney }: { higherIsBetter?: boolean; formatMoney?: (paisa: number) => string } = {},
): Delta | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
  const diff = cur - prev;
  if (diff === 0) return null;
  const up = diff > 0;
  let text: string;
  if (kind === 'ratio') text = `${trim1(Math.abs(diff / prev) * 100)}%`;
  else if (kind === 'points') {
    const pts = Math.abs(diff) * 100;
    const s = pts.toFixed(1).replace(/\.0$/, '');
    text = `${s} ${s === '1' ? 'pt' : 'pts'}`;
  } else if (kind === 'money') text = (formatMoney ?? String)(Math.abs(diff));
  else text = Math.abs(diff).toLocaleString('en-IN');
  return { label: `${up ? '↑' : '↓'} ${text}`, good: up === higherIsBetter };
}

/** Tones for paid plans in `plans` order (Figma legend 15:319: brand-100, brand-500, brand-700); Free = subtle. */
const paidTones: ChartTone[] = ['soft', 'brand-500', 'brand-700', 'brand', 'info', 'accent'];
export function planTones(plans: Pick<AnalyticsPlanRef, 'code' | 'monthly_price_amount' | 'sort'>[]): Record<string, ChartTone> {
  const out: Record<string, ChartTone> = {};
  const paid = [...plans].filter((p) => p.monthly_price_amount > 0).sort((a, b) => a.sort - b.sort || a.monthly_price_amount - b.monthly_price_amount);
  paid.forEach((p, i) => (out[p.code] = paidTones[i % paidTones.length]!));
  for (const p of plans) if (!(p.code in out)) out[p.code] = 'subtle';
  return out;
}

export const RANGES: AnalyticsRange[] = ['30d', 'quarter', '12m', 'custom'];
export const rangeLabels: Record<AnalyticsRange, string> = { '30d': '30 days', quarter: 'Quarter', '12m': '12 months', custom: 'Custom' };

/** `?range=` → a valid range, else the page default. */
export function rangeFromParam(v: string | null, fallback: AnalyticsRange, allowCustom: boolean): AnalyticsRange {
  return v && RANGES.includes(v as AnalyticsRange) && (allowCustom || v !== 'custom') ? (v as AnalyticsRange) : fallback;
}

/** "just now", "12 min ago", "3 h ago", "1 day ago", "5 days ago", then the date. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const mins = Math.max(0, Math.floor((now - t) / 60_000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t));
}
