import { formatBdt, formatCount } from '@storeplix/ui';

export { formatBdt, formatCount };

/** 8801712345678 → "+880 1712-345678" (Customers 63:14974 phone column). */
export function formatIntlPhone(msisdn: string | null | undefined): string {
  if (!msisdn) return '—';
  const m = /^880(1\d{3})(\d{6})$/.exec(msisdn);
  return m ? `+880 ${m[1]}-${m[2]}` : msisdn;
}

/** "Since Mar 2025". */
export function monthYear(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

/** "12 Nov 2026, 10:20". */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** Profit per unit "৳ 1,350 · 39%" (price − cost of the card variant; contract §4). */
export function profitOf(price: number, cost: number | null): { amount: number; percent: number } | null {
  if (cost === null || price <= 0) return null;
  const amount = price - cost;
  return { amount, percent: Math.round((amount / price) * 100) };
}
