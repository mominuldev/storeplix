import type { FeatureAccess } from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { formatBdt } from '../catalog/format';
import { smsParts, type SmsCount } from './smsParts';
import {
  CAMPAIGN_LIMITS,
  CAMPAIGN_SEGMENT_PARAMS,
  CAMPAIGN_SEGMENTS,
  type Campaign,
  type CampaignAudience,
  type CampaignChannel,
  type CampaignLanguage,
  type CampaignSegment,
  type CampaignStatus,
  type CreateCampaignInput,
  type CustomerMarketingStatus,
  type RecipientStatus,
  type SkipReason,
} from '@storeplix/types';

// PHASE-8-5 §3 / §8 pure helpers: labels and tones, segment catalogue, merge fields, the rendered SMS/email sample
// (prefix + footer, P85-6/P85-18), store-timezone scheduling with quiet hours (P85-15/16) and the plan note.

// ---------- status / channel ----------

export const campaignStatusMeta: Record<CampaignStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  sending: { label: 'Sending', tone: 'warning' },
  sent: { label: 'Sent', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** Figma Recent campaigns CHANNEL tag: SMS info-tone, Email brand-tone (§8.1). */
export const channelMeta: Record<CampaignChannel, { label: string; tone: BadgeTone }> = {
  sms: { label: 'SMS', tone: 'info' },
  email: { label: 'Email', tone: 'brand' },
};

export const failureLabels: Record<string, string> = {
  limit: 'Not enough allowance left this month',
  plan: 'Your plan doesn’t include campaigns',
  store_unavailable: 'Your shop wasn’t live',
  no_recipients: 'Nobody could be messaged',
};

export const recipientStatusMeta: Record<RecipientStatus, { label: string; tone: BadgeTone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  sending: { label: 'Sending', tone: 'warning' },
  sent: { label: 'Sent', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'warning' },
};

export const skipReasonLabels: Record<SkipReason, string> = {
  opted_out: 'Opted out',
  customer_deleted: 'Customer deleted',
  address_changed: 'Address changed',
  not_eligible: 'Not eligible',
  cancelled: 'Campaign cancelled',
  plan: 'Plan limit',
  store_unavailable: 'Shop not live',
};

export const errorCodeLabels: Record<string, string> = {
  provider_error: 'Provider error',
  invalid_address: 'Invalid address',
};

/** Which state-changing actions a campaign offers (P85-17). */
export function campaignActions(status: CampaignStatus) {
  return {
    edit: status === 'draft' || status === 'scheduled',
    unschedule: status === 'scheduled',
    cancel: status === 'draft' || status === 'scheduled' || status === 'sending',
    remove: status === 'draft',
    duplicate: true,
  };
}

// ---------- segments (§3.2) ----------

export const SEGMENTS: readonly CampaignSegment[] = CAMPAIGN_SEGMENTS;

/** Loose read view of the params union (every key optional). */
type ParamsView = { min_orders?: number; inactive_days?: number; min_spent_amount?: number; days?: number; districts?: string[]; tag?: string };
export const paramsOf = (a: Pick<CampaignAudience, 'params'>): ParamsView => a.params as ParamsView;

const P = CAMPAIGN_SEGMENT_PARAMS;

/** A well-typed audience for `segment`, keeping the exclusions and any compatible params from `prev`. */
export function withSegment(segment: CampaignSegment, prev?: CampaignAudience): CampaignAudience {
  const exclude = prev?.exclude ?? { risky: true, ordered_within_days: 7 };
  const old = prev && prev.segment === segment ? paramsOf(prev) : {};
  switch (segment) {
    case 'repeat_inactive':
      return { segment, params: { min_orders: old.min_orders ?? P.repeat_inactive.min_orders.default, inactive_days: old.inactive_days ?? P.repeat_inactive.inactive_days.default }, exclude };
    case 'vip':
      return { segment, params: { min_spent_amount: old.min_spent_amount ?? P.vip.min_spent_amount.default }, exclude };
    case 'new_customers':
      return { segment, params: { days: old.days ?? P.new_customers.days.default }, exclude };
    case 'district':
      return { segment, params: { districts: old.districts ?? [] }, exclude };
    case 'tag':
      return { segment, params: { tag: old.tag ?? '' }, exclude };
    case 'all':
    case 'one_time':
      return { segment, params: {}, exclude };
  }
}

/** Same audience with some params replaced (the segment stays). */
export function withParams(a: CampaignAudience, patch: ParamsView): CampaignAudience {
  return { ...a, params: { ...paramsOf(a), ...patch } } as CampaignAudience;
}

export const segmentBounds = {
  min_orders: [P.repeat_inactive.min_orders.min, P.repeat_inactive.min_orders.max],
  inactive_days: [P.repeat_inactive.inactive_days.min, P.repeat_inactive.inactive_days.max],
  days: [P.new_customers.days.min, P.new_customers.days.max],
  ordered_within_days: [1, 60],
} as const;

const timesWord = (n: number) => (n === 2 ? 'twice' : `${n}+ times`);

/** UI label of an audience (mirrors the API's `audience_label`; Figma "Bought twice, inactive 60 days"). */
export function segmentLabel(a: Pick<CampaignAudience, 'segment' | 'params'>): string {
  const p = paramsOf(a);
  switch (a.segment) {
    case 'all':
      return 'All customers you can message';
    case 'repeat_inactive':
      return `Bought ${timesWord(p.min_orders ?? 2)}, inactive ${p.inactive_days ?? 60} days`;
    case 'vip':
      return `VIP · spent over ${formatBdt(p.min_spent_amount ?? 2_000_000)}`;
    case 'new_customers':
      return `First order in the last ${p.days ?? 30} days`;
    case 'one_time':
      return 'Ordered once';
    case 'district':
      return p.districts && p.districts.length > 0 ? `Customers in ${p.districts.join(', ')}` : 'Customers in a district';
    case 'tag':
      return p.tag ? `Tagged “${p.tag}”` : 'Customers with a tag';
  }
}

/** Short option label for the segment select (parameters are edited inline). */
export const segmentOptionLabel: Record<CampaignSegment, string> = {
  all: 'All customers you can message',
  repeat_inactive: 'Repeat buyers who went quiet',
  vip: 'VIP · big spenders',
  new_customers: 'New customers',
  one_time: 'Ordered once',
  district: 'Customers in a district',
  tag: 'Customers with a tag',
};

/** Client-side completeness of the audience params (the API validates the bounds). */
export function audienceProblem(a: CampaignAudience): string | null {
  const p = paramsOf(a);
  if (a.segment === 'district' && !(p.districts && p.districts.length > 0)) return 'Pick at least one district.';
  if (a.segment === 'tag' && !p.tag?.trim()) return 'Type a tag.';
  if (a.segment === 'vip' && !(p.min_spent_amount && p.min_spent_amount > 0)) return 'Enter an amount.';
  return null;
}

// ---------- merge fields (P85-20) ----------

export type MergeField = 'name' | 'coupon' | 'shop_link' | 'product';
export const MERGE_FIELDS: readonly { field: MergeField; label: string }[] = [
  { field: 'name', label: '+ Customer name' },
  { field: 'coupon', label: '+ Coupon code' },
  { field: 'shop_link', label: '+ Shop link' },
  { field: 'product', label: '+ Product' },
];

const FIELD_RE = /\{([^{}\s]*)\}/g;

export function usedMergeFields(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(FIELD_RE), (m) => m[1]!)));
}

export function unknownMergeFields(text: string): string[] {
  const known = new Set<string>(MERGE_FIELDS.map((f) => f.field));
  return usedMergeFields(text).filter((f) => !known.has(f));
}

/** Insert `{field}` at the caret (or the end), with a space before it when needed. */
export function insertAt(text: string, insert: string, start: number | null | undefined, end?: number | null): { text: string; caret: number } {
  const s = start ?? text.length;
  const e = end ?? s;
  const before = text.slice(0, s);
  const pad = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const next = `${before}${pad}${insert}${text.slice(e)}`;
  return { text: next, caret: before.length + pad.length + insert.length };
}

// ---------- rendered sample (§5.2) ----------

/** Sample unsubscribe code (10 base62 chars) so the footer length matches a real one. */
export const SAMPLE_CODE = 'Ab3dE5gH7k';
/** Sample name of 20 characters: the estimate's worst case (P85-20 caps names at 20). */
export const SAMPLE_LONG_NAME = 'Nasrin Akter Chowdhu';
export const SAMPLE_NAME: Record<CampaignLanguage, string> = { bn: 'নাসরিন', en: 'Nasrin' };
const NAME_FALLBACK: Record<CampaignLanguage, string> = { bn: 'গ্রাহক', en: 'there' };

export function smsPrefix(shopName: string): string {
  return `${shopName.trim().slice(0, CAMPAIGN_LIMITS.sms_prefix_shop_name_max)}: `;
}

export function smsFooter(language: CampaignLanguage, host: string, code = SAMPLE_CODE): string {
  return language === 'bn' ? `বন্ধ করতে: ${host}/u/${code}` : `STOP: ${host}/u/${code}`;
}

export interface SampleContext {
  channel: CampaignChannel;
  language: CampaignLanguage;
  shopName: string;
  host: string;
  couponCode: string | null;
  product: { name: string; slug: string } | null;
  /** Merge value for `{name}`; defaults to the 20-char sample used for counting. */
  name?: string | null;
}

export function mergeBody(body: string, ctx: SampleContext): string {
  const link = ctx.channel === 'sms' ? ctx.host : `https://${ctx.host}`;
  return body.replace(FIELD_RE, (whole, f: string) => {
    switch (f) {
      case 'name':
        return (ctx.name === undefined ? SAMPLE_LONG_NAME : ctx.name) || NAME_FALLBACK[ctx.language];
      case 'coupon':
        return ctx.couponCode ?? 'CODE';
      case 'shop_link':
        return link;
      case 'product':
        return ctx.product ? `${ctx.product.name} ${ctx.host}/products/${ctx.product.slug}` : `${ctx.host}/products/…`;
      default:
        return whole;
    }
  });
}

export interface SmsSample {
  prefix: string;
  body: string;
  footer: string;
  text: string;
  count: SmsCount;
}

/** Full SMS as sent (`"{shop}: " + body + "\n" + footer`) and its part count. */
export function renderSms(body: string, ctx: SampleContext): SmsSample {
  const prefix = smsPrefix(ctx.shopName);
  const merged = mergeBody(body, ctx);
  const footer = smsFooter(ctx.language, ctx.host);
  const text = `${prefix}${merged}\n${footer}`;
  return { prefix, body: merged, footer, text, count: smsParts(text) };
}

/** Counter hint under the SMS box (§8.3; money-saving text removed). */
export function smsHint(c: SmsCount): string {
  const lang = c.encoding === 'ucs2' ? 'Bangla' : 'English';
  if (c.parts <= 1) {
    const left = Math.max(0, c.single - c.units);
    return `${lang} SMS fits ${c.single} characters each. ${left} ${left === 1 ? 'character' : 'characters'} left in this SMS.`;
  }
  const cut = c.units - c.single;
  return `${lang} SMS fits ${c.single} characters each. Cut ${cut} ${cut === 1 ? 'character' : 'characters'} to send 1 SMS.`;
}

export const MAX_SMS_PARTS = CAMPAIGN_LIMITS.sms_max_parts;
export const MAX_EMAIL_BODY = CAMPAIGN_LIMITS.email_body_max;
export const MAX_SUBJECT = CAMPAIGN_LIMITS.email_subject_max;

/** Segment bar 70:20277: one filled segment per part (alternating brand tones) then the unused rest of the last part. */
export function partSegments(c: SmsCount): { size: number; filled: boolean }[] {
  if (c.parts === 0) return [{ size: c.single, filled: false }];
  const out: { size: number; filled: boolean }[] = [];
  let left = c.units;
  for (let i = 0; i < c.parts; i++) {
    const take = Math.min(c.perPart, left);
    out.push({ size: take, filled: true });
    left -= take;
  }
  const rest = c.parts * c.perPart - c.units;
  if (rest > 0) out.push({ size: rest, filled: false });
  return out;
}

// ---------- store timezone + scheduling (P85-15, P85-16) ----------

function zonedParts(ts: number, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour! % 24, mi: +p.minute!, s: +p.second! };
}

function tzOffsetMs(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - (ts - (ts % 1000));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" + "HH:mm" in `tz` → ISO 8601 UTC (null when malformed). */
export function zonedToIso(date: string, time: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) return null;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +t[1]!, +t[2]!);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return new Date(ts).toISOString();
}

/** ISO → { date: "YYYY-MM-DD", time: "HH:mm" } in `tz`. */
export function isoToZoned(iso: string, tz: string): { date: string; time: string } {
  const p = zonedParts(Date.parse(iso), tz);
  return { date: `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`, time: `${pad2(p.h)}:${pad2(p.mi)}` };
}

export const QUIET_FROM = 21;
export const QUIET_UNTIL = 9;

/** True when `ts` falls in 21:00–09:00 store time (no campaign may start). */
export function inQuietHours(ts: number, tz: string): boolean {
  const h = zonedParts(ts, tz).h;
  return h >= QUIET_FROM || h < QUIET_UNTIL;
}

/** Client check of a schedule time; the server re-checks (S124). */
export function scheduleProblem(iso: string | null, tz: string, now = Date.now()): string | null {
  if (!iso) return 'Pick a date and time.';
  const ts = Date.parse(iso);
  if (ts < now + 5 * 60_000) return 'Pick a time at least 5 minutes from now.';
  if (ts > now + 90 * 86_400_000) return 'Campaigns can be scheduled up to 90 days ahead.';
  if (inQuietHours(ts, tz)) return quietHoursMessage();
  return null;
}

export const quietHoursMessage = () => 'Campaigns can’t start between 9 PM and 9 AM shop time. Pick a time after 9 AM.';

/** Short name of the time zone for field labels ("GMT+6"). */
export function tzLabel(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

/** "18 Nov · 7:30 PM" in store time. */
export function whenLabel(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${day} · ${time}`;
}

/** Row date: scheduled → scheduled_at, else started_at, else created_at. */
export const campaignDate = (c: Pick<Campaign, 'status' | 'scheduled_at' | 'started_at' | 'created_at'>) =>
  c.status === 'scheduled' ? c.scheduled_at : (c.started_at ?? c.created_at);

// ---------- plan (P85-13) ----------

export type CampaignLimitKey = 'campaign_sms_per_month' | 'campaign_emails_per_month';
export const limitKeyOf = (ch: CampaignChannel): CampaignLimitKey => (ch === 'sms' ? 'campaign_sms_per_month' : 'campaign_emails_per_month');

/** `{limit, used}` of a campaign allowance from `/features` (undefined until the API reports it). */
export function allowanceOf(features: FeatureAccess | undefined, ch: CampaignChannel): { limit: number | null; used: number } | undefined {
  const limits = features?.limits as Record<string, { limit: number | null; used: number } | undefined> | undefined;
  return limits?.[limitKeyOf(ch)];
}

export function allowanceLeft(a: { limit: number | null; used: number } | undefined): number | null {
  if (!a || a.limit === null) return null;
  return Math.max(0, a.limit - a.used);
}

/** Free plan (both allowances 0) → "Campaigns are part of the Starter plan." and create/send disabled. */
export function campaignsLocked(features: FeatureAccess | undefined): boolean {
  if (!features) return false;
  const sms = allowanceOf(features, 'sms');
  const email = allowanceOf(features, 'email');
  if (!sms && !email) return false; // API without 8.5 limits: let the server answer (402)
  return (sms?.limit ?? 0) === 0 && (email?.limit ?? 0) === 0;
}

// ---------- customer marketing row (§8.5) ----------

export const marketingStateLabel: Record<CustomerMarketingStatus, string> = {
  subscribed: 'Subscribed',
  unsubscribed: 'Unsubscribed',
  not_eligible: 'Not eligible',
  no_address: 'No address',
};

// ---------- composer form ----------

export interface ComposerState {
  name: string;
  channel: CampaignChannel;
  language: CampaignLanguage;
  audience: CampaignAudience;
  body: string;
  subject: string;
  coupon: { id: string; code: string } | null;
  product: { id: string; name: string; slug: string } | null;
  sendMode: 'now' | 'schedule';
  date: string;
  time: string;
}

export function defaultAudience(): CampaignAudience {
  return withSegment('all');
}

/** Tomorrow 10:00 store time (inside sending hours). */
function defaultSchedule(tz: string, now = Date.now()) {
  const d = isoToZoned(new Date(now + 86_400_000).toISOString(), tz).date;
  return { date: d, time: '10:00' };
}

export function fromCampaign(c: Campaign | null, tz: string): ComposerState {
  const when = c?.scheduled_at ? isoToZoned(c.scheduled_at, tz) : defaultSchedule(tz);
  return {
    name: c?.name ?? '',
    channel: c?.channel ?? 'sms',
    language: c?.language ?? 'bn',
    audience: c?.audience ?? defaultAudience(),
    body: c?.body ?? '',
    subject: c?.subject ?? '',
    coupon: c?.coupon ?? null,
    product: c?.product ?? null,
    sendMode: c?.scheduled_at ? 'schedule' : 'now',
    ...when,
  };
}

export function toInput(f: ComposerState, tz: string): CreateCampaignInput {
  return {
    name: f.name.trim() || defaultName(f),
    channel: f.channel,
    language: f.language,
    audience: f.audience,
    body: f.body,
    subject: f.channel === 'email' ? f.subject.trim() : null,
    coupon_id: f.coupon?.id ?? null,
    product_id: f.product?.id ?? null,
    scheduled_at: f.sendMode === 'schedule' ? zonedToIso(f.date, f.time, tz) : null,
  };
}

export function defaultName(f: Pick<ComposerState, 'channel' | 'audience'>): string {
  return `${channelMeta[f.channel].label} · ${segmentLabel(f.audience)}`.slice(0, 80);
}

/** Field → message before Save/Schedule (the API stays authoritative). */
export function validateComposer(f: ComposerState, sms: SmsCount | null): Record<string, string> {
  const e: Record<string, string> = {};
  const audience = audienceProblem(f.audience);
  if (audience) e.audience = audience;
  if (!f.body.trim()) e.body = 'Write your message.';
  const unknown = unknownMergeFields(f.body);
  if (unknown.length) e.body = `Unknown tag ${unknown.map((u) => `{${u}}`).join(', ')}. Use the buttons below to add tags.`;
  if (!e.body && f.body.includes('{coupon}') && !f.coupon) e.body = 'Pick a coupon for {coupon}.';
  if (!e.body && f.body.includes('{product}') && !f.product) e.body = 'Pick a product for {product}.';
  if (f.channel === 'sms' && sms && sms.parts > MAX_SMS_PARTS) e.body = `Too long: ${sms.parts} SMS per person. Keep it to ${MAX_SMS_PARTS}.`;
  if (f.channel === 'email') {
    if (!f.subject.trim()) e.subject = 'Add a subject.';
    else if (f.subject.length > MAX_SUBJECT) e.subject = `Keep the subject under ${MAX_SUBJECT} characters.`;
    else if (/[\r\n]/.test(f.subject)) e.subject = 'The subject must be one line.';
    if (f.body.length > MAX_EMAIL_BODY) e.body = `Keep the email under ${MAX_EMAIL_BODY.toLocaleString('en-US')} characters.`;
  }
  return e;
}
