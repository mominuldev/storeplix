// Money helpers (contract P4-4, §9.2): the API speaks integer paisa; the UI shows ৳ major units.
// Parsing uses integer maths after a strict pattern check, so "3450.5" → 345050 with no float drift.

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Bangla digits ০–৯ → 0–9. */
export function normalizeDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;

/**
 * "3,450", "৩৪৫০", "৳ 3450.50", "3450tk" → paisa. Empty → null. Anything else (3 decimals, letters,
 * negatives, > ৳99,999,999.99) → NaN so form schemas can reject it with a message.
 */
export function parseMoney(input: string): number | null {
  const cleaned = normalizeDigits(input)
    .trim()
    .replace(/^৳\s*/, '')
    .replace(/\s*(tk|taka|bdt)\.?$/i, '')
    .replace(/[,\s]/g, '');
  if (cleaned === '') return null;
  if (!MONEY.test(cleaned)) return Number.NaN;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Paisa → editable text ("345050" → "3450.50", "345000" → "3450"). */
export function moneyToInput(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined || !Number.isFinite(paisa)) return '';
  const whole = Math.trunc(paisa / 100);
  const frac = Math.abs(paisa % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}

/** South-Asian grouping: 1234567 → "12,34,567". */
function groupIndian(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Paisa → "৳ 3,450" / "৳ 3,450.50" / "৳ 1,84,200" (Figma uses lakh grouping). */
export function formatBdt(paisa: number | null | undefined, { symbol = true }: { symbol?: boolean } = {}): string {
  if (paisa === null || paisa === undefined || !Number.isFinite(paisa)) return '—';
  const neg = paisa < 0;
  const abs = Math.abs(paisa);
  const frac = abs % 100;
  const body = `${groupIndian(Math.trunc(abs / 100))}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
  return `${neg ? '−' : ''}${symbol ? '৳ ' : ''}${body}`;
}

/** Plain integer with lakh grouping (stock counts). */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n < 0 ? '−' : ''}${groupIndian(n)}`;
}

/**
 * Paisa → compact taka with Bangladeshi units (Figma platform analytics): "৳ 965", "৳ 35 K", "৳ 18.4 L", "৳ 2.21 Cr".
 * Three significant digits, trailing zeros trimmed. `tight` drops the space before the unit for axis ticks ("৳ 20L").
 */
export function formatBdtCompact(
  paisa: number | null | undefined,
  { symbol = true, tight = false }: { symbol?: boolean; tight?: boolean } = {},
): string {
  if (paisa === null || paisa === undefined || !Number.isFinite(paisa)) return '—';
  const neg = paisa < 0;
  const taka = Math.abs(paisa) / 100;
  const units: [number, string][] = [
    [10_000_000, 'Cr'],
    [100_000, 'L'],
    [1_000, 'K'],
  ];
  const unit = units.find(([size]) => taka >= size);
  let body: string;
  if (!unit) body = groupIndian(Math.round(taka));
  else {
    const n = taka / unit[0];
    const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
    const raw = (Math.round(n * 10 ** digits) / 10 ** digits).toFixed(digits);
    const fixed = raw.includes('.') ? raw.replace(/\.?0+$/, '') : raw;
    body = `${n >= 1000 ? groupIndian(Math.round(n)) : fixed}${tight ? '' : ' '}${unit[1]}`;
  }
  return `${neg ? '−' : ''}${symbol ? '৳ ' : ''}${body}`;
}
