// Phase 7 §8.3 report range: presets This month (default), Last month, Last 30 days, Last 90 days, Custom (≤ 366 days).
// Dates are store-local `YYYY-MM-DD` strings (the API reads them in `stores.timezone`); arithmetic runs on UTC midnights
// so no host timezone leaks in. The URL holds `?from=&to=`; no params = This month.

export type RangePreset = 'this_month' | 'last_month' | 'last_30' | 'last_90' | 'custom';
export interface ReportRange {
  from: string;
  to: string;
  preset: RangePreset;
}

export const MAX_RANGE_DAYS = 366;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const presetLabels: Record<RangePreset, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  last_30: 'Last 30 days',
  last_90: 'Last 90 days',
  custom: 'Custom',
};

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};
export const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000) + 1;
export const isIsoDate = (s: string | null | undefined): s is string => !!s && ISO.test(s) && !Number.isNaN(toDate(s).getTime()) && toIso(toDate(s)) === s;

/** Today in the store's timezone (falls back to the browser zone for an unknown id). */
export function localToday(timezone: string | null | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
}

export function presetRange(preset: Exclude<RangePreset, 'custom'>, today: string): ReportRange {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case 'this_month':
      return { from: monthStart, to: today, preset };
    case 'last_month': {
      const end = addDays(monthStart, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end, preset };
    }
    case 'last_30':
      return { from: addDays(today, -29), to: today, preset };
    case 'last_90':
      return { from: addDays(today, -89), to: today, preset };
  }
}

/** Validation for a custom range; null = fine. */
export function rangeError(from: string, to: string, today: string): string | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return 'Pick both dates.';
  if (from > to) return 'The start date must be before the end date.';
  if (from < '2020-01-01') return 'Reports start from 1 Jan 2020.';
  if (from > today) return 'The start date can’t be in the future.';
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return 'Pick at most 366 days.';
  return null;
}

/** The range for the current URL: a valid `from`/`to` pair (matched to a preset when equal), else This month. */
export function rangeFromParams(params: URLSearchParams, today: string): ReportRange {
  const from = params.get('from');
  const to = params.get('to');
  if (isIsoDate(from) && isIsoDate(to) && !rangeError(from, to, today)) {
    const clippedTo = to > today ? today : to;
    for (const p of ['this_month', 'last_month', 'last_30', 'last_90'] as const) {
      const r = presetRange(p, today);
      if (r.from === from && r.to === clippedTo) return r;
    }
    return { from, to: clippedTo, preset: 'custom' };
  }
  return presetRange('this_month', today);
}

/** "1 – 23 Nov 2026", "28 Oct – 23 Nov 2026", "1 Dec 2025 – 3 Jan 2026". */
export function rangeLabel(from: string, to: string): string {
  const f = toDate(from);
  const t = toDate(to);
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
  if (from === to) return fmt(t, { day: 'numeric', month: 'short', year: 'numeric' });
  if (f.getUTCFullYear() !== t.getUTCFullYear()) return `${fmt(f, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmt(t, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  if (f.getUTCMonth() !== t.getUTCMonth()) return `${fmt(f, { day: 'numeric', month: 'short' })} – ${fmt(t, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `${f.getUTCDate()} – ${fmt(t, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** "Fri 14 Nov" for a local date string. */
export function dayLabel(date: string, withWeekday = true): string {
  return toDate(date).toLocaleDateString('en-GB', { timeZone: 'UTC', ...(withWeekday ? { weekday: 'short' } : {}), day: 'numeric', month: 'short' }).replace(',', '');
}

/** "2026-W36" → "W36". */
export const weekLabel = (week: string) => week.replace(/^\d{4}-/, '');
