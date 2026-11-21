const SYMBOLS: Record<string, string> = { BDT: '৳' };

/** Display a price supplied by the API. Never computes prices - formatting only. */
export function formatPrice(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const symbol = SYMBOLS[code];
  if (symbol) {
    return `${symbol} ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount)}`;
  }
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${code} ${amount}`;
  }
}
