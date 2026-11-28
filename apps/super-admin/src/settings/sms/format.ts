import {
  PLATFORM_SMS_STOP_FOOTER,
  PLATFORM_SMS_TYPE_LABELS,
  SMS_MESSAGE_GROUP_LABELS,
  SMS_TEMPLATE_BODY_MAX,
  SMS_TEMPLATE_MAX_PARTS,
  type PlatformSmsAlert,
  type PlatformSmsAudience,
  type PlatformSmsAudienceCounts,
  type PlatformSmsBroadcastStatus,
  type PlatformSmsErrorCode,
  type PlatformSmsGroup,
  type PlatformSmsLogFilters,
  type PlatformSmsMergeField,
  type PlatformSmsRecentError,
  type PlatformSmsRecipientStatus,
  type PlatformSmsSkipReason,
  type PlatformSmsType,
  type SmsBalanceStatus,
  type SmsMessageGroup,
  type SmsMessageStatus,
  type SmsProviderHealth,
  type SmsProviderRole,
  type SubscriptionStatus,
} from '@storeplix/types';
import { formatCount, normalizeDigits, type BadgeTone } from '@storeplix/ui';
import { smsParts, type SmsCount } from './smsParts';

// PHASE-8-9B §11 pure helpers for /settings/sms (unit-tested in format.test.ts).

// ----- Tabs (§11: `?tab=provider|messages|broadcasts|log`, unknown → provider) -----
export type SmsSettingsTab = 'provider' | 'messages' | 'broadcasts' | 'log';
export const SMS_SETTINGS_TABS: readonly SmsSettingsTab[] = ['provider', 'messages', 'broadcasts', 'log'];
export const SMS_SETTINGS_TAB_LABELS: Record<SmsSettingsTab, string> = {
  provider: 'Provider',
  messages: 'Message types',
  broadcasts: 'Broadcasts',
  log: 'SMS log',
};
export function parseSmsSettingsTab(value: string | null | undefined): SmsSettingsTab {
  return (SMS_SETTINGS_TABS as readonly string[]).includes(value ?? '') ? (value as SmsSettingsTab) : 'provider';
}

// ----- Phones (P89B-26: any BD mobile, normalised `8801…`) -----
/** "01711-555211", "+880 1711 555211", "৮৮০১৭১১৫৫৫২১১" → "8801711555211"; anything else → null. */
export function normalizeBdPhone(input: string): string | null {
  const digits = normalizeDigits(input).replace(/[\s\-().+]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const local = digits.startsWith('880') ? `0${digits.slice(3)}` : digits.startsWith('1') && digits.length === 10 ? `0${digits}` : digits;
  return /^01[3-9]\d{8}$/.test(local) ? `88${local}` : null;
}

let lastTestPhone = '';
/** Staff profiles have no phone yet (§18): the last number typed in this tab pre-fills the next test dialog. */
export const testPhoneMemory = {
  get: () => lastTestPhone,
  set: (v: string) => {
    lastTestPhone = v;
  },
};

// ----- Connection fields -----
/** Client mirror of the server's https rule (S224): the server decides. */
export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' && !!u.hostname;
  } catch {
    return false;
  }
}

/** Typed confirmation (P89B-7): trimmed, case-insensitive; the server re-checks. */
export function nameMatches(typed: string, name: string): boolean {
  return typed.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase() && typed.trim() !== '';
}

/** "1,177" / "1177" → 1177; anything else → null. */
export function parseTypedCount(typed: string): number | null {
  const t = normalizeDigits(typed).trim().replace(/,/g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** Two-letter logo tile ("REVE SMS" → "RS", "SSL Wireless" → "SW", "Alpha" → "AL"). */
export function providerInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

/** "৳ 0.40" per SMS part (catalogue prices are paisa). */
export function perPart(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return '—';
  return `৳ ${(paisa / 100).toFixed(2)}`;
}

// ----- Labels and tones -----
export const roleMeta: Record<SmsProviderRole, { label: string; tone: BadgeTone }> = {
  primary: { label: 'Primary', tone: 'brand' },
  failover: { label: 'Failover', tone: 'info' },
  draft: { label: 'Draft', tone: 'neutral' },
  inactive: { label: 'Inactive', tone: 'neutral' },
  removed: { label: 'Removed', tone: 'neutral' },
};

export const healthMeta: Record<SmsProviderHealth, { label: string; tone: BadgeTone }> = {
  healthy: { label: 'Connected', tone: 'success' },
  failing: { label: 'Failing', tone: 'warning' },
  failed_over: { label: 'Failed over', tone: 'danger' },
  unknown: { label: 'No sends yet', tone: 'neutral' },
};

export const balanceStatusMeta: Record<SmsBalanceStatus, { label: string; tone: BadgeTone } | null> = {
  ok: { label: 'Healthy', tone: 'success' },
  low: { label: 'Low', tone: 'warning' },
  error: { label: 'Couldn’t read', tone: 'danger' },
  unsupported: null,
  unknown: { label: 'Not read yet', tone: 'neutral' },
};

export const logStatusMeta: Record<SmsMessageStatus, { label: string; tone: BadgeTone }> = {
  sent: { label: 'Sent', tone: 'success' },
  queued: { label: 'Queued', tone: 'info' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export const groupTone: Record<PlatformSmsGroup, BadgeTone> = {
  registration: 'brand',
  billing: 'neutral',
  security: 'info',
  promotional: 'warning',
};
/** Short log pills (Figma 2098:10472: Login / Billing / Registration / Promotional). */
export const groupShortLabel: Record<PlatformSmsGroup, string> = {
  registration: 'Registration',
  billing: 'Billing',
  security: 'Login',
  promotional: 'Promotional',
};

export const broadcastStatusMeta: Record<PlatformSmsBroadcastStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  sending: { label: 'Sending', tone: 'brand' },
  sent: { label: 'Sent', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const recipientStatusMeta: Record<PlatformSmsRecipientStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'info' },
  sent: { label: 'Sent', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export const skipReasonLabel: Record<PlatformSmsSkipReason, string> = {
  opted_out: 'opted out',
  no_verified_phone: 'no verified phone',
  weekly_cap: 'weekly cap reached',
  suspended: 'suspended',
  duplicate: 'duplicate owner',
};

export const recentResultMeta: Record<PlatformSmsRecentError['result'], { label: string; tone: BadgeTone }> = {
  failed: { label: 'Failed', tone: 'danger' },
  failed_over: { label: 'Sent by failover', tone: 'success' },
  retrying: { label: 'Retrying', tone: 'info' },
};

export const errorCodeLabel: Record<PlatformSmsErrorCode, string> = {
  provider_error: 'Rejected by the provider',
  provider_unavailable: 'Provider unavailable',
  provider_timeout: 'Provider timed out',
  provider_auth: 'Credentials refused',
  no_route: 'No provider can send this',
};

export function typeLabel(type: PlatformSmsType | 'shop' | 'test'): string {
  if (type === 'shop') return 'Shop SMS';
  if (type === 'test') return 'Test SMS';
  return PLATFORM_SMS_TYPE_LABELS[type];
}

export function groupsLabel(groups: readonly SmsMessageGroup[]): string {
  return groups.map((g) => SMS_MESSAGE_GROUP_LABELS[g]).join(', ') || '—';
}

const ALERT_RANK: Record<PlatformSmsAlert['severity'], number> = { danger: 3, warning: 2, info: 1 };
/** The shell shows only the most severe alert (§11). */
export function topAlert(alerts: readonly PlatformSmsAlert[] | undefined): PlatformSmsAlert | null {
  if (!alerts?.length) return null;
  return [...alerts].sort((a, b) => ALERT_RANK[b.severity] - ALERT_RANK[a.severity])[0] ?? null;
}

// ----- Dhaka dates and the promotional sending window (P89B-18) -----
const TZ = 'Asia/Dhaka';
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

/** "2026-11-28" in Dhaka. */
export function dhakaDay(date: Date = new Date()): string {
  return dayKeyFmt.format(date);
}
/** Dhaka day `n` days before `now`. */
export function dhakaDaysAgo(n: number, now: Date = new Date()): string {
  return dhakaDay(new Date(now.getTime() - n * 86_400_000));
}
/** "14:05" in Dhaka. */
export function dhakaTime(date: Date): string {
  return hmFmt.format(date).replace(/^24/, '00');
}
/** Dhaka has no DST: a date + time typed in GMT+6 → ISO (UTC). */
export function dhakaToIso(day: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${day}T${time}:00+06:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** 09:00 ≤ t < 21:00 Dhaka. */
export function withinSendingHours(date: Date): boolean {
  const hm = dhakaTime(date);
  return hm >= '09:00' && hm < '21:00';
}
export type ScheduleProblem = 'invalid' | 'outside_hours' | 'too_soon' | 'too_far';
/** Client mirror of the schedule rules (the server decides): window, ≥ now + 5 min, ≤ now + 30 days. */
export function scheduleProblem(day: string, time: string, now: Date = new Date()): ScheduleProblem | null {
  const iso = dhakaToIso(day, time);
  if (!iso) return 'invalid';
  const at = new Date(iso);
  if (!withinSendingHours(at)) return 'outside_hours';
  if (at.getTime() < now.getTime() + 5 * 60_000) return 'too_soon';
  if (at.getTime() > now.getTime() + 30 * 86_400_000) return 'too_far';
  return null;
}
export const scheduleProblemText: Record<ScheduleProblem, string> = {
  invalid: 'Pick a date and a time.',
  outside_hours: 'Promotional SMS can only go out between 9 AM and 9 PM Bangladesh time.',
  too_soon: 'Pick a time at least 5 minutes from now.',
  too_far: 'Pick a time within the next 30 days.',
};

// ----- Templates (P89B-14: same rules as 8.9a P89A-8) -----
const SAMPLE: Record<'bn' | 'en', Record<PlatformSmsMergeField, string>> = {
  en: {
    merchant_name: 'Nasrin',
    store_name: 'Mugdho Fashion',
    invoice_no: 'SP-2026-001042',
    amount: '1,770',
    due_date: '5 Dec 2026',
    plan: 'Growth',
    link: 'https://app.storeplix.com/settings/plan',
    otp: '482913',
  },
  bn: {
    merchant_name: 'নাসরিন',
    store_name: 'Mugdho Fashion',
    invoice_no: 'SP-2026-001042',
    amount: '1,770',
    due_date: '5 Dec 2026',
    plan: 'Growth',
    link: 'https://app.storeplix.com/settings/plan',
    otp: '482913',
  },
};
/** Sample opt-out link used only to count parts (the server adds the real one per recipient). */
export const SAMPLE_OPT_OUT_URL = 'https://app.storeplix.com/s/Ab3dE6gH9k';

const TAG = /\{([a-z_]+)\}/g;
/** Line breaks collapse to spaces, then trim (as the server renders). */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n|\r|\n/g, ' ').trim();
}
export function renderSample(body: string, language: 'bn' | 'en'): string {
  const values = SAMPLE[language];
  return normalizeBody(body).replace(TAG, (whole, name: string) => (name in values ? values[name as PlatformSmsMergeField] : whole));
}
export interface TemplateCount extends SmsCount {
  characters: number;
  /** Units over the 3-part capacity (0 when it fits). */
  over: number;
}
export function countText(text: string): TemplateCount {
  const c = smsParts(text);
  const capacity = (c.encoding === 'gsm7' ? 153 : 67) * SMS_TEMPLATE_MAX_PARTS;
  return { ...c, characters: Array.from(text).length, over: c.parts > SMS_TEMPLATE_MAX_PARTS ? c.units - capacity : 0 };
}
export function countTemplate(body: string, language: 'bn' | 'en'): TemplateCount {
  return countText(renderSample(body, language));
}
/** Broadcast text as sent (P89B-22): body + " " + the STOP footer in the recipient's language. */
export function countBroadcast(body: string, language: 'bn' | 'en'): TemplateCount {
  const footer = PLATFORM_SMS_STOP_FOOTER[language].replace('{url}', SAMPLE_OPT_OUT_URL);
  return countText(`${renderSample(body, language)} ${footer}`);
}
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
export function templateProblem(
  body: string,
  allowed: readonly string[],
  required: readonly string[],
  count: TemplateCount,
): TemplateProblem | null {
  const trimmed = body.trim();
  if (!trimmed) return { code: 'empty' };
  if (trimmed.length > SMS_TEMPLATE_BODY_MAX) return { code: 'too_long_chars', max: SMS_TEMPLATE_BODY_MAX };
  const tags = mergeTagsIn(trimmed);
  const unknown = tags.filter((t) => !allowed.includes(t));
  if (unknown.length) return { code: 'unknown', fields: unknown };
  const missing = required.filter((f) => !tags.includes(f));
  if (missing.length) return { code: 'missing', fields: [...missing] };
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
      return 'Links can’t be typed in. Use the {link} merge tag instead.';
    case 'too_long':
      return `Too long. Keep it within ${SMS_TEMPLATE_MAX_PARTS} parts — remove ${formatCount(Math.max(1, p.over))} characters.`;
  }
}
/** Insert `{field}` at the selection; returns the new body and caret position. */
export function insertAt(body: string, field: string, start: number, end: number): { body: string; caret: number } {
  const tag = `{${field}}`;
  const s = Math.max(0, Math.min(start, body.length));
  const e = Math.max(s, Math.min(end, body.length));
  return { body: body.slice(0, s) + tag + body.slice(e), caret: s + tag.length };
}

// ----- Broadcast audience (P89B-17) -----
export const BROADCAST_MERGE_FIELDS: readonly PlatformSmsMergeField[] = ['merchant_name', 'store_name', 'plan', 'link'];
export const AUDIENCE_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due', 'cancelled', 'expired'];
export const subscriptionStatusLabel: Record<SubscriptionStatus, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Past due',
  cancelled: 'Cancelled',
  expired: 'Expired',
};
/** Audience is complete enough to estimate (plan/status need ≥ 1 chip). */
export function audienceReady(a: PlatformSmsAudience): boolean {
  if (a.kind === 'plan') return !!a.plans?.length;
  if (a.kind === 'status') return !!a.statuses?.length;
  return true;
}
export function audienceLabel(a: PlatformSmsAudience, counts?: PlatformSmsAudienceCounts): string {
  switch (a.kind) {
    case 'all':
      return 'All merchants';
    case 'trial_ending':
      return 'Trial ending';
    case 'plan': {
      const names = (a.plans ?? []).map((code) => counts?.plans.find((p) => p.code === code)?.name ?? code);
      return `Plan: ${names.join(', ') || '—'}`;
    }
    case 'status':
      return `Status: ${(a.statuses ?? []).map((s) => subscriptionStatusLabel[s]).join(', ') || '—'}`;
  }
}
/** "96 opted out · 11 no verified phone" (zeros dropped). */
export function skippedLine(skipped: Partial<Record<PlatformSmsSkipReason, number>> | undefined): string {
  if (!skipped) return '';
  return (Object.entries(skipped) as [PlatformSmsSkipReason, number][])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${formatCount(n)} ${skipReasonLabel[k]}`)
    .join(' · ');
}

// ----- SMS log filters (§8: default 30 days, min −90; `q` = exact phone or shop name) -----
export interface LogFilterState {
  q: string;
  status: SmsMessageStatus | 'all';
  group: PlatformSmsGroup | 'all';
  from: string;
  to: string;
}

export function defaultLogFilters(now = new Date(), status: SmsMessageStatus | 'all' = 'all'): LogFilterState {
  return { q: '', status, group: 'all', from: dhakaDaysAgo(30, now), to: dhakaDay(now) };
}

/** UI state → API filters (`q` trimmed; "all" dropped). */
export function toLogQuery(f: LogFilterState, cursor?: string): PlatformSmsLogFilters {
  return {
    q: f.q.trim() || undefined,
    status: f.status === 'all' ? undefined : [f.status],
    group: f.group === 'all' ? undefined : [f.group],
    from: f.from || undefined,
    to: f.to || undefined,
    cursor,
  };
}

