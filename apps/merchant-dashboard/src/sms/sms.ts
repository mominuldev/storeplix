import type {
  BillingInvoiceSummary,
  PermissionKey,
  SmsCapabilities,
  SmsCreditLedgerType,
  SmsCreditPack,
  SmsCreditStatus,
  SmsLogEntry,
  SmsMergeField,
  SmsMessageStatus,
  SmsPurpose,
  SmsSenderIdStatus,
  SmsSenderIdUse,
  SmsTemplateEvent,
  SmsTemplateKey,
} from '@storeplix/types';
import {
  SMS_LOG_WINDOW_DAYS,
  SMS_SENDER_ID_DOCUMENT_MAX_BYTES,
  SMS_SENDER_ID_DOCUMENT_MIMES,
  SMS_SENDER_ID_PATTERN,
  SMS_TEMPLATE_BODY_MAX,
  SMS_TEMPLATE_MAX_PARTS,
} from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { formatCount } from '@storeplix/ui';
import { permissionsOf, type PermissionHolder } from '../lib/permissions';
import { smsParts, type SmsCount } from '../campaigns/smsParts';

// PHASE-8-9A §12 pure rules for the SMS page: tabs and permission gating (P89A-25), the client-side template part
// counter (mirrors the server's sample render, §7.3; the server preview stays authoritative), formatters and labels.

// ----- Tabs and permissions -----
export type SmsTab = 'overview' | 'templates' | 'sender-id' | 'log' | 'credits';
export const SMS_TABS: readonly SmsTab[] = ['overview', 'templates', 'sender-id', 'log', 'credits'];
export const SMS_TAB_LABELS: Record<SmsTab, string> = { overview: 'Overview', templates: 'Templates', 'sender-id': 'Sender ID', log: 'SMS log', credits: 'Buy credits' };

/** `?tab=` → a tab; unknown or missing → overview (§12). */
export function parseSmsTab(value: string | null | undefined): SmsTab {
  return (SMS_TABS as readonly string[]).includes(value ?? '') ? (value as SmsTab) : 'overview';
}

const has = (keys: readonly PermissionKey[], ...want: PermissionKey[]) => want.some((k) => keys.includes(k));

/** Page access: `settings.manage | integrations.manage | billing.view` (§2, §12). */
export function canOpenSms(m: PermissionHolder): boolean {
  return has(permissionsOf(m), 'settings.manage', 'integrations.manage', 'billing.view');
}

/** `SmsOverview.can` computed from the membership (same mapping as §10.1); the server's flags win once loaded. */
export function smsCapabilities(m: PermissionHolder): SmsCapabilities {
  const p = permissionsOf(m);
  const settingsOrIntegrations = has(p, 'settings.manage', 'integrations.manage');
  return {
    edit_templates: has(p, 'settings.manage'),
    send_test: settingsOrIntegrations,
    view_log: settingsOrIntegrations,
    view_sender_ids: settingsOrIntegrations,
    request_sender_id: has(p, 'integrations.manage'),
    view_credit_history: has(p, 'billing.view'),
    buy_credits: has(p, 'billing.manage'),
    edit_low_credit_alert: has(p, 'billing.manage', 'settings.manage'),
  };
}

/** Tabs shown for these capabilities (Sender ID needs `view_sender_ids`, SMS log `view_log`; the rest always). */
export function visibleTabs(can: SmsCapabilities): SmsTab[] {
  return SMS_TABS.filter((t) => (t === 'sender-id' ? can.view_sender_ids : t === 'log' ? can.view_log : true));
}

// ----- Template counter (§7.3 sample values, P89A-8, P89A-17) -----
export interface SampleContext {
  shop: string;
  /** Effective order prefix (`commerce.order_prefix`). */
  orderPrefix: string;
  /** Primary host, e.g. `mugdho.storeplix.com`. */
  host: string;
  /** The store's receipt footer, else "Thank you". */
  footer?: string | null;
  /** An approved (masked) sender ID drops a leading "{shop}: " (P89A-17). */
  masked: boolean;
}

export function sampleValues(ctx: SampleContext, language: 'bn' | 'en'): Record<SmsMergeField, string> {
  const host = ctx.host || 'shop.storeplix.com';
  return {
    first_name: language === 'bn' ? 'নাসরিন' : 'Nasrin',
    shop: ctx.shop,
    number: `${ctx.orderPrefix || 'SP'}-1042`,
    total: '1,770',
    due: '1,770',
    carrier: 'Steadfast',
    track_url: `https://${host}/track`,
    amount: '500',
    url: `https://${host}/pay/Ab12Cd34Ef56`,
    method: language === 'bn' ? 'নগদ' : 'Cash',
    footer: ctx.footer?.trim() || 'Thank you',
    code: '482913',
  };
}

const TAG = /\{([a-z_]+)\}/g;
const SHOP_PREFIX = '{shop}: ';

/** Line breaks collapse to spaces, then trim (as `SmsTemplates::fill`). */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n|\r|\n/g, ' ').trim();
}

/** The sample render the server checks (§7.3): prefix rule, then every known `{field}` filled. */
export function renderSample(body: string, ctx: SampleContext, language: 'bn' | 'en'): string {
  let text = normalizeBody(body);
  if (ctx.masked && text.startsWith(SHOP_PREFIX)) text = text.slice(SHOP_PREFIX.length);
  const values = sampleValues(ctx, language);
  return text.replace(TAG, (whole, name: string) => (name in values ? values[name as SmsMergeField] : whole));
}

export interface TemplateCount extends SmsCount {
  /** Characters of the sample render (code points). */
  characters: number;
  /** Units over the 3-part capacity (0 when it fits). */
  over: number;
  /** 3-part capacity in this encoding (459 GSM-7 septets, 201 UCS-2 units). */
  capacity: number;
}

/** Client mirror of the server's part count of the sample render; `smsParts` (P85-18) does the counting. */
export function countTemplate(body: string, ctx: SampleContext, language: 'bn' | 'en'): TemplateCount {
  const text = renderSample(body, ctx, language);
  const c = smsParts(text);
  const capacity = (c.encoding === 'gsm7' ? 153 : 67) * SMS_TEMPLATE_MAX_PARTS;
  return { ...c, characters: Array.from(text).length, capacity, over: c.parts > SMS_TEMPLATE_MAX_PARTS ? c.units - capacity : 0 };
}

/** `{x}` tags in a body, in order, unique. */
export function mergeTagsIn(body: string): string[] {
  return [...new Set(Array.from(body.matchAll(TAG), (m) => m[1]!))];
}

const LINK = /https?:\/\/|www\./i;

export type TemplateProblem =
  | { code: 'empty' }
  | { code: 'too_long_chars'; max: number }
  | { code: 'unknown'; fields: string[] }
  | { code: 'missing'; fields: string[] }
  | { code: 'link' }
  | { code: 'too_long'; parts: number; over: number };

/** First client-side problem with a draft body (same order of checks the server applies, P89A-8). */
export function templateProblem(body: string, allowed: readonly SmsMergeField[], required: readonly SmsMergeField[], count: TemplateCount): TemplateProblem | null {
  const trimmed = body.trim();
  if (!trimmed) return { code: 'empty' };
  if (trimmed.length > SMS_TEMPLATE_BODY_MAX) return { code: 'too_long_chars', max: SMS_TEMPLATE_BODY_MAX };
  const tags = mergeTagsIn(trimmed);
  const unknown = tags.filter((t) => !(allowed as readonly string[]).includes(t));
  if (unknown.length) return { code: 'unknown', fields: unknown };
  const missing = required.filter((f) => !tags.includes(f));
  if (missing.length) return { code: 'missing', fields: missing };
  if (LINK.test(trimmed)) return { code: 'link' };
  if (count.parts > SMS_TEMPLATE_MAX_PARTS) return { code: 'too_long', parts: count.parts, over: count.over };
  return null;
}

export function templateProblemText(p: TemplateProblem): string {
  switch (p.code) {
    case 'empty':
      return 'Write a message first.';
    case 'too_long_chars':
      return `Keep the text under ${p.max} characters.`;
    case 'unknown':
      return `${p.fields.map((f) => `{${f}}`).join(', ')} ${p.fields.length === 1 ? 'isn’t a merge tag' : 'aren’t merge tags'} for this message. Use the Insert chips.`;
    case 'missing':
      return `Keep ${p.fields.map((f) => `{${f}}`).join(', ')} — this message needs it.`;
    case 'link':
      return 'Links can’t be typed in. Use the link merge tags instead.';
    case 'too_long':
      return `Too long for one message. Keep it within ${SMS_TEMPLATE_MAX_PARTS} parts — remove ${formatCount(Math.max(1, p.over))} characters to save.`;
  }
}

/** Insert `{field}` at the selection; returns the new body and caret position. */
export function insertAt(body: string, field: string, start: number, end: number): { body: string; caret: number } {
  const tag = `{${field}}`;
  const s = Math.max(0, Math.min(start, body.length));
  const e = Math.max(s, Math.min(end, body.length));
  return { body: body.slice(0, s) + tag + body.slice(e), caret: s + tag.length };
}

/** "When: …" lines (§12.2). */
export const TEMPLATE_WHEN: Record<SmsTemplateKey, string> = {
  order_placed: 'a customer places an order',
  order_confirmed: 'you confirm the order',
  order_shipped: 'parcel is booked with a courier',
  order_cancelled: 'order is cancelled',
  order_updated: 'you edit the order',
  payment_link: 'you request an advance or send a payment link',
  pos_receipt: 'till sale with the buyer’s phone number',
  checkout_otp: 'a buyer verifies their phone at checkout',
};

export const ORDER_TEMPLATE_KEYS: readonly SmsTemplateEvent[] = ['order_placed', 'order_confirmed', 'order_shipped', 'order_cancelled', 'order_updated', 'payment_link'];

// ----- Formatters -----
/** 0.986 → "98.6%"; null → "—" (P89A-22). The API sends a 0–1 ratio; a value > 1 is taken as a percent already. */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  const pct = rate > 1 ? rate : rate * 100;
  return `${(Math.round(pct * 10) / 10).toFixed(1)}%`;
}

export function creditStatusMeta(status: SmsCreditStatus): { label: string; tone: BadgeTone } | null {
  if (status === 'healthy') return { label: 'Healthy', tone: 'success' };
  if (status === 'low') return { label: 'Low', tone: 'warning' };
  if (status === 'empty') return { label: 'Empty', tone: 'danger' };
  return null;
}

/** "260 of 500 left this month" / "Unlimited". */
export function allowanceLine(a: { limit: number | null; remaining: number | null }): string {
  if (a.limit === null) return 'Unlimited';
  return `${formatCount(a.remaining ?? 0)} of ${formatCount(a.limit)} left this month`;
}

/** Used fraction for the bar (0–1); unlimited → 0. */
export function allowanceUsedFraction(a: { limit: number | null; used: number }): number {
  if (!a.limit) return a.limit === 0 ? 1 : 0;
  return Math.min(1, Math.max(0, a.used / a.limit));
}

/** "1 Dec" — first day of next month (allowance reset). */
export function nextResetLabel(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "21:00" → "9 PM". */
export function hourLabel(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
}

export function quietHoursLabel(q: { from: string; to: string }): string {
  return `${hourLabel(q.from)} – ${hourLabel(q.to)}`;
}

/** 8801711552211 / 01711552211 → "01711-•••211" (same shape as the API's `to_masked`). */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('880') ? `0${digits.slice(3)}` : digits;
  if (local.length < 8) return local;
  return `${local.slice(0, 5)}-•••${local.slice(-3)}`;
}

/** "৳ 0.32 per SMS" (price paisa / credits, 2 decimals). */
export function perSmsPrice(pack: Pick<SmsCreditPack, 'credits' | 'price_amount'>): string {
  const taka = pack.price_amount / 100 / pack.credits;
  return `৳ ${taka.toFixed(2)} per SMS`;
}

/** Badge on a pack card (§12.5). */
export function packBadge(pack: Pick<SmsCreditPack, 'code'>): string | null {
  if (pack.code === 'credits_5000') return 'Most popular';
  if (pack.code === 'credits_10000') return 'Best value';
  return null;
}

/** Average credits used per day this month (store month ≈ local month); null when unknown. */
export function dailyCreditPace(creditsUsedThisMonth: number, now = new Date()): number | null {
  const day = now.getDate();
  if (creditsUsedThisMonth <= 0 || day <= 0) return null;
  return creditsUsedThisMonth / day;
}

/** "about 3 weeks" / "about 2 months" for `credits` at `perDay`; null when the pace is unknown. */
export function paceDuration(credits: number, perDay: number | null): string | null {
  if (!perDay || perDay <= 0) return null;
  const days = credits / perDay;
  if (days < 14) {
    const d = Math.max(1, Math.round(days));
    return `about ${d} ${d === 1 ? 'day' : 'days'}`;
  }
  if (days < 42) {
    const w = Math.round(days / 7);
    return `about ${w} weeks`;
  }
  const mo = Math.round(days / 30);
  return mo >= 24 ? `about ${Math.round(mo / 12)} years` : `about ${mo} months`;
}

// ----- SMS log (§12.4) -----
export type PurposeChip = 'all' | 'order' | 'otp' | 'campaign' | 'automation' | 'pos' | 'test';
export const PURPOSE_CHIPS: { value: PurposeChip; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'order', label: 'Order' },
  { value: 'otp', label: 'OTP' },
  { value: 'campaign', label: 'Campaign' },
  { value: 'automation', label: 'Automation' },
  { value: 'pos', label: 'POS receipt' },
  { value: 'test', label: 'Test' },
];

/** Chip → `filter[purpose]` list; `all` → undefined (no filter). */
export function purposesFor(chip: PurposeChip): SmsPurpose[] | undefined {
  switch (chip) {
    case 'all':
      return undefined;
    case 'order':
      return [...ORDER_TEMPLATE_KEYS];
    case 'otp':
      return ['checkout_otp'];
    case 'campaign':
      return ['campaign'];
    case 'automation':
      return ['automation'];
    case 'pos':
      return ['pos_receipt'];
    case 'test':
      return ['sms_test'];
  }
}

/** Purpose tag in the log: short label + tone (Figma: Order brand, OTP info, Campaign warning, others neutral). */
export function purposeTag(p: SmsPurpose): { label: string; tone: BadgeTone } {
  if ((ORDER_TEMPLATE_KEYS as readonly string[]).includes(p)) return { label: 'Order', tone: 'brand' };
  if (p === 'checkout_otp') return { label: 'OTP', tone: 'info' };
  if (p === 'campaign') return { label: 'Campaign', tone: 'warning' };
  if (p === 'automation') return { label: 'Automation', tone: 'neutral' };
  if (p === 'pos_receipt') return { label: 'POS receipt', tone: 'neutral' };
  return { label: 'Test', tone: 'neutral' };
}

export function logStatusMeta(e: Pick<SmsLogEntry, 'status' | 'error_code'>): { label: string; tone: BadgeTone; sub: string | null } {
  switch (e.status) {
    case 'sent':
      return { label: 'Sent', tone: 'success', sub: null };
    case 'failed':
      return { label: 'Failed', tone: 'danger', sub: 'Provider error' };
    case 'skipped':
      return { label: 'Skipped', tone: 'neutral', sub: 'No SMS left' };
    default:
      return { label: 'Queued', tone: 'neutral', sub: null };
  }
}

export const LOG_STATUS_OPTIONS: { value: '' | SmsMessageStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'queued', label: 'Queued' },
];

/** Message cell: checkout codes are never shown (P89A-21). */
export function logMessage(e: Pick<SmsLogEntry, 'purpose' | 'body_preview'>): { text: string; muted: boolean } {
  if (e.purpose === 'checkout_otp') return { text: 'Checkout code (hidden)', muted: true };
  if (!e.body_preview) return { text: '—', muted: true };
  return { text: e.body_preview, muted: false };
}

export function chargedLabel(c: SmsLogEntry['charged_from']): string {
  return c === 'allowance' ? 'Allowance' : c === 'credits' ? 'Credits' : '—';
}

/** Link target for a log reference. */
export function referenceHref(r: SmsLogEntry['reference']): string | null {
  if (!r) return null;
  if (r.type === 'order') return `/orders/${encodeURIComponent(r.id)}`;
  if (r.type === 'campaign') return `/marketing/campaigns/${encodeURIComponent(r.id)}`;
  if (r.type === 'automation') return `/marketing/automations/${encodeURIComponent(r.id)}`;
  return `/pos/history?sale=${encodeURIComponent(r.id)}`;
}

/** YYYY-MM-DD in local time. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysBack(days: number, now = new Date()): string {
  return ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
}

/** Default range (last 30 days) and the earliest allowed date (today − 90). */
export function logDateBounds(now = new Date()): { from: string; to: string; min: string } {
  return { from: daysBack(30, now), to: ymd(now), min: daysBack(SMS_LOG_WINDOW_DAYS, now) };
}

/** YYYY-MM-DD of an instant in a time zone (undefined = the browser's). */
function ymdIn(d: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return ymd(d);
  }
}

/** "Today, 3:42 PM" / "Yesterday, 8:05 PM" / "12 Nov, 4:12 PM" in the store's time zone. */
export function logTime(iso: string, timeZone?: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let time: string;
  let date: string;
  try {
    time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
    date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone });
  } catch {
    time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  const day = ymdIn(d, timeZone);
  if (day === ymdIn(now, timeZone)) return `Today, ${time}`;
  if (day === ymdIn(new Date(now.getTime() - 86_400_000), timeZone)) return `Yesterday, ${time}`;
  return `${date}, ${time}`;
}

/** "Asia/Dhaka" → "Bangladesh" (SMS log subtitle); other zones as given. */
export function timeZoneName(tz: string | null | undefined): string {
  if (!tz || tz === 'Asia/Dhaka' || tz === 'Asia/Dacca') return 'Bangladesh';
  return tz;
}

// ----- Sender ID (§12.3) -----
export const SENDER_STATUS_META: Record<SmsSenderIdStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending review', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  superseded: { label: 'Replaced', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'danger' },
};

export function usesLabel(uses: readonly SmsSenderIdUse[]): string {
  const words: Record<SmsSenderIdUse, string> = { order_updates: 'order updates', otp: 'OTP', pos_receipts: 'POS receipts' };
  const list = uses.map((u) => words[u]);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export function senderIdValid(value: string): boolean {
  return SMS_SENDER_ID_PATTERN.test(value);
}

/** Client pre-check of the trade licence (type + size); the API sniffs again. */
export function documentProblem(file: Pick<File, 'type' | 'size'>): string | null {
  if (!(SMS_SENDER_ID_DOCUMENT_MIMES as readonly string[]).includes(file.type)) return 'Upload a PDF, JPG, PNG or WebP file.';
  if (file.size > SMS_SENDER_ID_DOCUMENT_MAX_BYTES) return 'The file is larger than 5 MB.';
  return null;
}

export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// ----- Credits and purchase history (§12.5) -----
export const LEDGER_LABELS: Record<SmsCreditLedgerType, string> = {
  purchase: 'Purchase',
  consume: 'Used',
  refund: 'Refund',
  admin_adjust: 'Adjusted by Store Plix',
};

export function signedCredits(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatCount(Math.abs(n))}`;
}

export function purchaseStatus(inv: Pick<BillingInvoiceSummary, 'status' | 'due_at'>, now = Date.now()): { label: string; tone: BadgeTone } {
  if (inv.status === 'paid') return { label: 'Paid', tone: 'success' };
  if (inv.status === 'open') return { label: 'Pending', tone: 'warning' };
  const due = Date.parse(inv.due_at);
  return !Number.isNaN(due) && due <= now ? { label: 'Expired', tone: 'neutral' } : { label: 'Cancelled', tone: 'neutral' };
}

export const LOW_CREDIT_OPTIONS: { value: '' | '100' | '200' | '500'; label: string }[] = [
  { value: '', label: 'Off' },
  { value: '100', label: 'Below 100 credits' },
  { value: '200', label: 'Below 200 credits' },
  { value: '500', label: 'Below 500 credits' },
];
