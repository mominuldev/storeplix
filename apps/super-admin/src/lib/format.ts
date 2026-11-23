import { formatBdt } from '@storeplix/ui';

// Contract conventions: dates are UTC ISO 8601 in the API; the admin UI shows them in Asia/Dhaka.
const TZ = 'Asia/Dhaka';
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const shortTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const monthFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  month: 'long',
  year: 'numeric',
});

const parse = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "17 Nov 2026" */
export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? dateFmt.format(d) : '—';
}

/** "11:42:08" */
export function formatTime(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? timeFmt.format(d) : '';
}

/** "17 Nov 2026, 10:00 am" */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? `${dateFmt.format(d)}, ${shortTimeFmt.format(d)}` : '—';
}

export function formatMonth(date = new Date()): string {
  return monthFmt.format(date);
}

/** Whole days from now until `iso` (negative when past). */
export function daysUntil(iso: string | null | undefined, now = Date.now()): number | null {
  const d = parse(iso);
  return d ? Math.ceil((d.getTime() - now) / 86_400_000) : null;
}

export const money = (paisa: number | null | undefined) => formatBdt(paisa);

/** `starter` → "Starter" (plan names are not in the summary resources). */
export function planName(code: string | null | undefined): string {
  if (!code) return '—';
  return code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');
}

export function intervalLabel(interval: 'month' | 'year' | null | undefined): string {
  return interval === 'year' ? 'Yearly' : interval === 'month' ? 'Monthly' : '';
}

/** Payment provider labels (Figma method chip). */
export function providerLabel(provider: string | null | undefined): string {
  switch (provider) {
    case 'bkash':
      return 'bKash';
    case 'sslcommerz':
      return 'SSLCommerz';
    case 'manual':
      return 'Manual';
    case null:
    case undefined:
    case '':
      return '—';
    default:
      return planName(provider);
  }
}
