import {
  EXPENSE_AMOUNT_MAX,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_MIN_DATE,
  EXPENSE_NOTE_MAX,
  EXPENSE_RECEIPT_DOWNSCALE_PX,
  PAID_FROM_OPTIONS,
  type Expense,
  type ExpenseCategory,
  type ExpenseSummary,
  type PaidFrom,
} from '@storeplix/types';
import type { BadgeTone, ChartTone } from '@storeplix/ui';
import { z } from 'zod';

// PHASE-8-7 §3 / §10.1 helpers for the Expenses page (Figma 144:41614).

export const categoryLabel = (c: ExpenseCategory) => EXPENSE_CATEGORY_LABELS[c].en;

/**
 * Category Tag tone, as drawn in Figma 144:42315 (Ads brand, Packaging info, Salaries neutral, Rent & bills warning,
 * Courier info, Other neutral).
 */
export const categoryTone: Record<ExpenseCategory, BadgeTone> = {
  ads: 'brand',
  packaging: 'info',
  salaries: 'neutral',
  rent_bills: 'warning',
  courier: 'info',
  other: 'neutral',
};

/** By-category bar fill (144:42444: Ads brand-500, Salaries info, Rent & bills warning, Packaging success, Other muted; Courier composed). */
export const categoryBarTone: Record<ExpenseCategory, ChartTone> = {
  ads: 'brand-500',
  packaging: 'success',
  salaries: 'info',
  rent_bills: 'warning',
  courier: 'accent',
  other: 'muted',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11` → "November". */
export const monthName = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;
/** `2026-11` → "November 2026". */
export const monthLabel = (ym: string) => `${monthName(ym)} ${ym.slice(0, 4)}`;
/** `2026-11-19` → "19 Nov". */
export const shortDate = (d: string) => `${d.slice(8, 10)} ${SHORT[Number(d.slice(5, 7)) - 1] ?? ''}`;

export const isMonth = (s: string | null | undefined): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && s >= '2020-01';
export const isCategory = (s: string | null | undefined): s is ExpenseCategory => !!s && (EXPENSE_CATEGORIES as readonly string[]).includes(s);

/** `change_pct` → "↑ 12% vs October" (null → hidden). Spending more is the bad direction. */
export function compareLine(compare: ExpenseSummary['compare']): { text: string; up: boolean } | null {
  if (compare.change_pct === null) return null;
  const up = compare.change_pct > 0;
  const arrow = compare.change_pct === 0 ? '' : up ? '↑ ' : '↓ ';
  return { text: `${arrow}${Math.abs(compare.change_pct)}% vs ${monthName(compare.label_month)}`, up };
}

/** Share 0–1 (4 decimals) → "47%". */
export const sharePct = (share: number | null | undefined) => (share === null || share === undefined ? '—' : `${Math.round(share * 100)}%`);

/** Bar width as % of the largest category (144:42444). */
export function categoryBars(summary: Pick<ExpenseSummary, 'by_category'>) {
  const rows = summary.by_category.filter((c) => c.amount > 0);
  const max = Math.max(0, ...rows.map((c) => c.amount));
  return rows.map((c) => ({ ...c, width: max > 0 ? (c.amount / max) * 100 : 0 }));
}

/** Total row (144:42390): all → "n expenses this month"; a category chip → "n {category} expenses" + its total. */
export function totalRow(summary: Pick<ExpenseSummary, 'count' | 'total_amount' | 'by_category'>, category: ExpenseCategory | null) {
  if (!category) return { label: `${summary.count} ${summary.count === 1 ? 'expense' : 'expenses'} this month`, amount: summary.total_amount };
  const c = summary.by_category.find((x) => x.category === category);
  const n = c?.count ?? 0;
  return { label: `${n} ${categoryLabel(category)} ${n === 1 ? 'expense' : 'expenses'}`, amount: c?.amount ?? 0 };
}

// ---------- Form (§8.3) ----------

export function expenseSchema(today: string) {
  return z.object({
    amount: z
      .number({ error: (iss) => (iss.input === undefined || iss.input === null ? 'Enter the amount.' : 'Enter an amount like 2400 or 2400.50.') })
      .nullable()
      .refine((v) => v !== null, 'Enter the amount.')
      .refine((v) => v === null || v >= 1, 'The amount must be more than ৳ 0.')
      .refine((v) => v === null || v <= EXPENSE_AMOUNT_MAX, 'The amount may be at most ৳ 1,00,00,000.'),
    category: z.enum(EXPENSE_CATEGORIES as unknown as [ExpenseCategory, ...ExpenseCategory[]]),
    paid_from: z.enum(PAID_FROM_OPTIONS as unknown as [PaidFrom, ...PaidFrom[]]),
    spent_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.')
      .refine((d) => d >= EXPENSE_MIN_DATE, 'Pick a date from 2020 onwards.')
      .refine((d) => d <= today, 'The date can’t be in the future. Use “Repeat every month” for planned costs.'),
    note: z
      .string()
      .max(EXPENSE_NOTE_MAX, `Keep the note under ${EXPENSE_NOTE_MAX} characters.`)
      .refine((s) => !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'Remove special characters from the note.'),
    repeat_monthly: z.boolean(),
  });
}
export type ExpenseValues = z.input<ReturnType<typeof expenseSchema>>;

export const emptyValues = (today: string): ExpenseValues => ({ amount: null, category: 'ads', paid_from: 'cash', spent_on: today, note: '', repeat_monthly: false });

export const valuesOf = (e: Expense): ExpenseValues => ({
  amount: e.amount,
  category: e.category,
  paid_from: e.paid_from,
  spent_on: e.spent_on,
  note: e.note ?? '',
  repeat_monthly: e.repeat_monthly,
});

/** Trimmed note → null when empty (the API stores null). */
export const noteOf = (note: string) => note.trim() || null;

/** §10.1 back-dating hint: an expense dated in an earlier month changes that month's Profit & loss. */
export function backdateHint(spentOn: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn) || spentOn.slice(0, 7) >= today.slice(0, 7)) return null;
  const ym = spentOn.slice(0, 7);
  return `This changes Profit & loss for ${ym.slice(0, 4) === today.slice(0, 4) ? monthName(ym) : monthLabel(ym)}.`;
}

// ---------- Receipt downscale (§10.1) ----------

/** Target size for a photo whose long side exceeds `max` (null = keep as is). */
export function downscaleSize(width: number, height: number, max = EXPENSE_RECEIPT_DOWNSCALE_PX): { width: number; height: number } | null {
  const long = Math.max(width, height);
  if (long <= max || long <= 0) return null;
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export const isImageFile = (f: Blob) => /^image\/(jpeg|png|webp)$/.test(f.type);

type Decoded = { width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; close: () => void };

/** `createImageBitmap` applies EXIF orientation; every supported browser has it (without it the photo passes through). */
async function decode(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return { width: bmp.width, height: bmp.height, draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h), close: () => bmp.close() };
}

/**
 * Photos whose long side is over 2,560 px are redrawn on a canvas and re-encoded as JPEG 0.85, so 48–50 MP phone photos
 * never hit the API's 40 MP limit (§5.1). PDFs, small images and anything the browser can't decode pass through.
 */
export async function prepareReceipt(file: File): Promise<File> {
  if (!isImageFile(file)) return file;
  let decoded: Decoded | null;
  try {
    decoded = await decode(file);
  } catch {
    return file;
  }
  if (!decoded) return file;
  try {
    const size = downscaleSize(decoded.width, decoded.height);
    if (!size) return file;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    decoded.draw(ctx, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally {
    decoded.close();
  }
}
