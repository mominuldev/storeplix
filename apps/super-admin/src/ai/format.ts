import { AI_CREDIT_ADJUST_MAX, type AiCreditLedgerEntry, type AiCreditLedgerType, type AiCreditSource, type AiGenerationKind } from '@storeplix/types';

// PHASE-8-9D §10.4 helpers for the merchant AI credits card, adjust dialog and ledger (pure, unit-tested).

/** P89D-35: an admin adjustment is ±1…100,000 bonus credits (never 0). */
export { AI_CREDIT_ADJUST_MAX };

export const fmt = (n: number) => n.toLocaleString('en-IN');

/** "+500" / "−20" (true minus sign). */
export function signed(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-IN');
  return n > 0 ? `+${abs}` : n < 0 ? `−${abs}` : '0';
}

export const aiLedgerTypeLabel: Record<AiCreditLedgerType, string> = {
  consume: 'Used',
  refund: 'Refund',
  admin_adjust: 'Staff adjustment',
};

export const aiSourceLabel: Record<AiCreditSource, string> = {
  allowance: 'Plan allowance',
  bonus: 'Bonus',
};

export const aiGenerationKindLabel: Record<AiGenerationKind, string> = {
  product_description: 'Product description',
  photo_edit: 'Photo edit',
};

/** Ledger "Tool / reason" column: the staff reason, or the AI tool for consume/refund rows. */
export function ledgerDetail(e: AiCreditLedgerEntry): string {
  if (e.type === 'admin_adjust') return e.reason ?? '—';
  if (!e.generation) return '—';
  const kind = aiGenerationKindLabel[e.generation.kind];
  return e.type === 'refund' ? `${kind} · failed or undone` : kind;
}

export type AdjustMode = 'grant' | 'deduct';

export interface AdjustPreview {
  /** signed change sent to the API (0 while the field is empty/invalid) */
  delta: number;
  after: number;
  error: string | null;
}

/**
 * Adjust dialog preview + validation: whole number 1…100,000; a deduction can't take the bonus below 0 (the API
 * answers 422 `ai_credits_insufficient` too).
 */
export function aiAdjustPreview(bonus: number, mode: AdjustMode, raw: string): AdjustPreview {
  const text = raw.trim().replace(/,/g, '');
  if (text === '') return { delta: 0, after: bonus, error: null };
  if (!/^\d+$/.test(text)) return { delta: 0, after: bonus, error: 'Enter a whole number of credits.' };
  const n = Number(text);
  if (n < 1 || n > AI_CREDIT_ADJUST_MAX) return { delta: 0, after: bonus, error: `Enter a whole number from 1 to ${fmt(AI_CREDIT_ADJUST_MAX)}.` };
  const delta = mode === 'grant' ? n : -n;
  const after = bonus + delta;
  if (after < 0) return { delta, after, error: `Can’t go below 0 — the shop has ${fmt(bonus)} bonus credits.` };
  return { delta, after, error: null };
}

/** Reason presets (same shape as the SMS dialog). Picking one fills the reason (shown to the merchant on the ledger). */
export const aiAdjustReasons: { key: string; label: string; hint: string; text: string }[] = [
  { key: 'service_issue', label: 'Service issue', hint: 'Make up for poor or failed AI results', text: 'Service issue: credits for AI results that didn’t work as expected.' },
  { key: 'trial', label: 'Trial boost', hint: 'Let the shop try the AI tools', text: 'Trial boost: bonus AI credits to try the AI tools.' },
  { key: 'promotion', label: 'Promotion', hint: 'Launch offer or goodwill bonus', text: 'Promotion: bonus AI credits from Store Plix.' },
  { key: 'correction', label: 'Correction', hint: 'Undo a wrong earlier adjustment', text: 'Correction of an earlier adjustment.' },
];
