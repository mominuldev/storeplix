import { z } from 'zod';
import { parseDay } from './format';

export const MIN_FROM = '2024-01-01';
export const MAX_DAYS = 731;

/** Custom range (P82-17): dates, from ≤ to, ≤ 731 days, from ≥ 2024-01-01, to ≤ the latest day. */
export function customRangeSchema(maxTo: string) {
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');
  return z
    .object({ from: day, to: day })
    .refine((r) => r.from >= MIN_FROM, { path: ['from'], message: 'Analytics start on 1 Jan 2024.' })
    .refine((r) => r.to <= maxTo, { path: ['to'], message: 'Pick a day up to the latest computed day.' })
    .refine((r) => r.from <= r.to, { path: ['to'], message: '“To” must be on or after “From”.' })
    .refine((r) => (parseDay(r.to)!.getTime() - parseDay(r.from)!.getTime()) / 86_400_000 + 1 <= MAX_DAYS, {
      path: ['to'],
      message: 'Pick at most 731 days.',
    });
}

