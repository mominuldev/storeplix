import type { DocumentKind } from '@storeplix/types';
import { plural } from '../catalog/format';

// Template cards on Invoices & labels 39:10790 (paper sizes per Q51).
export const documentKindLabels: Record<DocumentKind, { name: string; paper: string; action: string; noun: (n: number) => string }> = {
  invoice_a4: { name: 'A4 invoice', paper: '210 × 297 mm', action: 'Invoice', noun: (n) => plural(n, 'invoice') },
  receipt_80mm: { name: 'Thermal receipt', paper: '80 mm roll', action: 'Thermal receipt', noun: (n) => plural(n, 'receipt') },
  label_4x6: { name: 'Courier label', paper: '4 × 6 in', action: 'Courier label', noun: (n) => plural(n, 'label') },
  invoice_a5_two_up: { name: 'A5 two-up', paper: '2 per A4 sheet', action: 'A5 invoice', noun: (n) => plural(n, 'invoice') },
  packing_slip: { name: 'Packing slip', paper: 'For packers', action: 'Packing slip', noun: (n) => plural(n, 'packing slip') },
};

export const documentKinds: DocumentKind[] = ['invoice_a4', 'receipt_80mm', 'label_4x6', 'invoice_a5_two_up', 'packing_slip'];

/** Labels track `label_printed_at`; every other kind tracks `invoice_printed_at` (P5B-53). */
export const printedKey = (kind: DocumentKind): 'invoice' | 'label' => (kind === 'label_4x6' ? 'label' : 'invoice');
