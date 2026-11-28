import { SMS_CREDIT_ADJUST_MAX, SMS_SENDER_ID_PATTERN, SMS_SENDER_ID_USE_LABELS, type SmsCreditLedgerType, type SmsCreditStatus, type SmsSenderIdStatus, type SmsSenderIdUse } from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';

// PHASE-8-9A §13 helpers for the sender-ID queue, the review drawer and the SMS credits card (pure, unit-tested).

export const senderIdStatusMeta: Record<SmsSenderIdStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending review', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  superseded: { label: 'Replaced', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'danger' },
};

/** Queue PURPOSE column, e.g. "Order updates, OTP codes" (in the canonical order). */
export function usesLabel(uses: SmsSenderIdUse[]): string {
  const order: SmsSenderIdUse[] = ['order_updates', 'otp', 'pos_receipts'];
  const list = order.filter((u) => uses.includes(u)).map((u) => SMS_SENDER_ID_USE_LABELS[u]);
  return list.length ? list.join(', ') : '—';
}

const TZ = 'Asia/Dhaka';
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });

/** SUBMITTED second line (Figma 2087:8323): "Today, 3:40 PM" · "Yesterday" · "3 days ago" · "5 weeks ago". Dhaka days. */
export function relativeDay(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((Date.parse(dayKey.format(now)) - Date.parse(dayKey.format(d))) / 86_400_000);
  if (days <= 0) return `Today, ${timeFmt.format(d).toUpperCase()}`;
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** "1.2 MB" / "640 KB" */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function mimeLabel(mime: string): string {
  switch (mime) {
    case 'application/pdf':
      return 'PDF';
    case 'image/jpeg':
      return 'JPG';
    case 'image/png':
      return 'PNG';
    case 'image/webp':
      return 'WebP';
    default:
      return mime;
  }
}

const letters = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Drawer "Automatic checks" (2095:8953), computed in the browser from the request: the BTRC pattern and whether the ID
 * looks like the shop or licence name (one contains the other once spaces/punctuation are dropped, or they share a
 * 4-letter start). Uniqueness is enforced by the API (409 `sender_id_taken`), so it is not shown as a check.
 */
export function senderIdChecks(senderId: string, shopName: string, businessName: string): { ok: boolean; label: string }[] {
  const id = letters(senderId);
  const like = (name: string) => {
    const n = letters(name);
    return !!n && !!id && (n.includes(id) || id.includes(n) || (id.length >= 4 && n.startsWith(id.slice(0, 4))));
  };
  return [
    {
      ok: SMS_SENDER_ID_PATTERN.test(senderId),
      label: SMS_SENDER_ID_PATTERN.test(senderId) ? `${senderId.length} characters, letters and numbers only` : 'Doesn’t match the 3–11 letters and numbers rule',
    },
    {
      ok: like(shopName) || like(businessName),
      label: like(shopName)
        ? `Similar to the shop name “${shopName}”`
        : like(businessName)
        ? `Similar to the licence name “${businessName}”`
        : `Not similar to the shop name “${shopName}” — check the licence`,
    },
  ];
}

/** Drawer reject chips (2095:8983): picking one fills the reason box with a merchant-facing sentence. */
export const rejectReasons: { key: string; label: string; text: (senderId: string) => string }[] = [
  {
    key: 'name_mismatch',
    label: 'Name doesn’t match licence',
    text: (id) => `The name on the trade licence doesn’t match ${id}. Upload a licence that matches, or request a sender ID close to the licence name.`,
  },
  {
    key: 'unreadable',
    label: 'Licence unreadable',
    text: () => 'We couldn’t read the trade licence. Upload a clear, complete scan or photo and request again.',
  },
  {
    key: 'not_allowed',
    label: 'Name not allowed',
    text: (id) => `${id} can’t be registered as a sender ID (protected brand, generic word or misleading name). Request a different ID.`,
  },
  { key: 'other', label: 'Other', text: () => '' },
];

// ----- SMS credits (§13.2) -----

export const creditStatusMeta: Record<SmsCreditStatus, { label: string; tone: BadgeTone }> = {
  none: { label: 'No credits', tone: 'neutral' },
  healthy: { label: 'Healthy', tone: 'success' },
  low: { label: 'Low', tone: 'warning' },
  empty: { label: 'Empty', tone: 'danger' },
};

export const ledgerTypeLabel: Record<SmsCreditLedgerType, string> = {
  purchase: 'Purchase',
  consume: 'SMS sent',
  refund: 'Refund',
  admin_adjust: 'Staff adjustment',
};

/** "+500" / "−20" (true minus sign). */
export function signed(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-IN');
  return n > 0 ? `+${abs}` : n < 0 ? `−${abs}` : '0';
}

export type AdjustMode = 'grant' | 'deduct';

export interface AdjustPreview {
  /** signed change sent to the API (0 while the field is empty/invalid) */
  delta: number;
  after: number;
  error: string | null;
}

/**
 * Adjust dialog preview + validation: whole number 1…1,000,000; a deduction can't take the balance below 0
 * (the API answers 422 `sms_credits_insufficient` too).
 */
export function adjustPreview(balance: number, mode: AdjustMode, raw: string): AdjustPreview {
  const text = raw.trim().replace(/,/g, '');
  if (text === '') return { delta: 0, after: balance, error: null };
  if (!/^\d+$/.test(text)) return { delta: 0, after: balance, error: 'Enter a whole number of credits.' };
  const n = Number(text);
  if (n < 1 || n > SMS_CREDIT_ADJUST_MAX) return { delta: 0, after: balance, error: `Enter a whole number from 1 to ${SMS_CREDIT_ADJUST_MAX.toLocaleString('en-IN')}.` };
  const delta = mode === 'grant' ? n : -n;
  const after = balance + delta;
  if (after < 0) return { delta, after, error: `Can’t go below 0 — the shop has ${balance.toLocaleString('en-IN')} purchased credits.` };
  return { delta, after, error: null };
}

/** Reason presets (2095:8356). Picking one fills the reason (shown to the merchant on the ledger). */
export const adjustReasons: { key: string; label: string; hint: string; text: string }[] = [
  { key: 'service_issue', label: 'Service issue', hint: 'Make up for failed or late SMS', text: 'Service issue: credits for SMS that failed or arrived late.' },
  { key: 'payment_fix', label: 'Payment fix', hint: 'Paid, but credits didn’t arrive', text: 'Payment fix: credits for a paid purchase that didn’t arrive.' },
  { key: 'promotion', label: 'Promotion', hint: 'Launch offer or goodwill bonus', text: 'Promotion: bonus SMS credits from Store Plix.' },
  { key: 'correction', label: 'Correction', hint: 'Undo a wrong earlier adjustment', text: 'Correction of an earlier adjustment.' },
];
