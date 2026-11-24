import {
  FRAUD_GUARD_BOUNDS,
  FRAUD_GUARD_NOTE_MAX,
  FRAUD_GUARD_RULES_TOTAL,
  type BlockedNumber,
  type FeatureAccess,
  type FraudGuardEvent,
  type FraudGuardEventType,
  type FraudGuardOverview,
  type FraudGuardSettings,
  type GuardHold,
  type GuardReason,
  type OrderGuard,
  type OrderSummary,
  type RiskTier,
} from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { riskTierMeta } from '@storeplix/ui';
import { formatBdt } from '../catalog/format';
import { ordinal } from '../commerce/format';
import { normalizeBdPhone } from '../lib/phone';

// PHASE-8-8 §3.3 / §5.4 / §10 helpers for the fake-order guard UI (Figma 39:11233, 33:3676, 144:46570).

export const tierLabel = (t: RiskTier) => riskTierMeta[t].label;

/** §10.2: the tier shown for an order — the check's tier, else the customer's own-shop tier. */
export function orderTier(o: Pick<OrderSummary, 'guard' | 'customer'>): RiskTier | null {
  return o.guard?.tier ?? o.customer.risk?.tier ?? null;
}

/** P88-2 hold Tag beside the Pending status (composed; never an "On hold" status). */
export const holdLabels: Record<GuardHold, string> = {
  call_first: 'Call first',
  advance: 'Waiting for advance',
  checking: 'Checking…',
};

/** "58% delivered (7 of 12)"; "No parcels at your shop yet" when total is 0. */
export function recordLine(r: { rate: number | null; delivered: number; total: number }): string {
  if (r.total === 0 || r.rate === null) return 'No parcels at your shop yet';
  return `${r.rate}% delivered (${r.delivered} of ${r.total})`;
}

/** §5.4 reason codes → merchant copy. `guard` gives the record numbers for the rate reasons. */
export function reasonText(reason: GuardReason, guard?: Pick<OrderGuard, 'rate' | 'record'> | null): string {
  const d = guard?.record?.delivered;
  const t = guard?.record?.total;
  const rec = guard?.rate !== null && guard?.rate !== undefined && t ? `${guard.rate}% delivered (${d} of ${t})` : null;
  switch (reason) {
    case 'rate_below_hold':
      return rec ? `only ${rec} — below your hold line` : 'delivery rate below your hold line';
    case 'rate_below_advance':
      return rec ? `${rec} — below your advance line` : 'delivery rate below your advance line';
    case 'few_parcels':
      return 'too few parcels at your shop to judge';
    case 'new_number':
      return 'first order from this number';
    case 'duplicate':
      return 'same phone ordered the same product recently';
    case 'blocked_number':
      return 'this number is on your blocked list';
    case 'no_gateway':
      return 'no payment gateway is connected to ask for an advance';
    case 'otp_unavailable':
      return 'the SMS code couldn’t be sent';
  }
}

const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** All reasons as one sentence ("Only 58% delivered (7 of 12) — below your hold line · first order …"). */
export function reasonsSentence(guard: Pick<OrderGuard, 'reasons' | 'rate' | 'record'> | null | undefined): string {
  if (!guard || guard.reasons.length === 0) return '';
  return capitalise(guard.reasons.map((r) => reasonText(r, guard)).join(' · '));
}

// ---------- Settings / rules (§10.1) ----------

export type RuleKey = 'hold' | 'advance' | 'otp' | 'returners' | 'duplicates' | 'limit';
type ToggleField = 'hold_enabled' | 'advance_enabled' | 'otp_enabled' | 'block_returners' | 'duplicates_enabled' | 'daily_limit_enabled';
type ValueField = 'hold_below' | 'advance_below' | 'block_after_returns' | 'duplicate_window_hours' | 'daily_limit';

export interface RuleDef {
  key: RuleKey;
  toggle: ToggleField;
  title: string;
  text: string;
  /** setting row ("Hold when delivery rate is below" + select); `null` field = fixed text */
  setting: { label: string; field: ValueField | null; fixed?: string; unit: (n: number) => string };
}

const pct = (n: number) => `${n}%`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The six built rules in Figma order (courier record and VPN rules are hidden, P88-7 / Q190). */
export const RULES: readonly RuleDef[] = [
  {
    key: 'hold',
    toggle: 'hold_enabled',
    title: 'Hold risky orders for a call',
    text: 'The order waits in Pending with a “Call first” tag until someone on your team confirms.',
    setting: { label: 'Hold when delivery rate is below', field: 'hold_below', unit: pct },
  },
  {
    key: 'advance',
    toggle: 'advance_enabled',
    title: 'Ask for delivery charge in advance',
    text: 'Sends a payment gateway link by SMS. The order confirms itself the moment payment arrives.',
    setting: { label: 'Ask when delivery rate is below', field: 'advance_below', unit: pct },
  },
  {
    key: 'otp',
    toggle: 'otp_enabled',
    title: 'Verify new numbers with OTP',
    text: 'First-time numbers confirm a 6-digit code at checkout before the order is placed.',
    setting: { label: 'Ask for OTP on', field: null, fixed: 'New numbers only', unit: String },
  },
  {
    key: 'returners',
    toggle: 'block_returners',
    title: 'Block repeat returners',
    text: 'Turns off cash on delivery for numbers that keep refusing parcels. They can still pay online.',
    setting: { label: 'Block after', field: 'block_after_returns', unit: (n) => plural(n, 'return', 'returns') },
  },
  {
    key: 'duplicates',
    toggle: 'duplicates_enabled',
    title: 'Catch duplicate orders',
    text: 'Same phone and same product inside the window is flagged as a duplicate, not shipped twice.',
    setting: { label: 'Duplicate window', field: 'duplicate_window_hours', unit: (n) => plural(n, 'hour', 'hours') },
  },
  {
    key: 'limit',
    toggle: 'daily_limit_enabled',
    title: 'Limit orders per phone',
    text: 'Stops one number from placing a pile of fake orders in a day.',
    setting: { label: 'Max orders per phone per day', field: 'daily_limit', unit: (n) => plural(n, 'order', 'orders') },
  },
];

const range = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const withValue = (opts: number[], v: number) => (opts.includes(v) ? opts : [...opts, v].sort((a, b) => a - b));

/**
 * Select options per field (always containing the current value). Percent lines keep `advance_below ≥ hold_below`
 * (§8.3): the hold line can't go above the advance line and vice versa.
 */
export function ruleOptions(field: ValueField, s: Pick<FraudGuardSettings, ValueField>): number[] {
  const v = s[field];
  switch (field) {
    case 'hold_below':
      return withValue(range(30, 90, 5), v).filter((n) => n <= s.advance_below);
    case 'advance_below':
      return withValue(range(50, 95, 5), v).filter((n) => n >= s.hold_below);
    case 'block_after_returns':
      return withValue(range(FRAUD_GUARD_BOUNDS.block_after_returns.min + 1, 10), v);
    case 'duplicate_window_hours':
      return [...FRAUD_GUARD_BOUNDS.duplicate_window_hours];
    case 'daily_limit':
      return withValue(range(1, 10), v);
  }
}

/** Rules switched on (of the six built). A store with the guard off has none on. */
export function rulesOn(s: FraudGuardSettings): number {
  if (!s.enabled) return 0;
  return RULES.filter((r) => s[r.toggle]).length;
}

export const RULES_TOTAL = FRAUD_GUARD_RULES_TOTAL;

/** Hero line: "5 of 6 rules on · checking your own orders". */
export function heroLine(on: number): string {
  return `${on} of ${RULES_TOTAL} rules on · checking your own orders`;
}

/** KPI split "41 held · 14 blocked · 8 duplicates" (daily-limit refusals added only when there are some). */
export function stoppedSplit(o: Pick<FraudGuardOverview, 'stopped'>): { total: number; text: string } {
  const s = o.stopped;
  const parts = [`${s.held} held`, `${s.blocked} blocked`, `${s.duplicates} ${s.duplicates === 1 ? 'duplicate' : 'duplicates'}`];
  if (s.limited > 0) parts.push(`${s.limited} over the limit`);
  return { total: s.held + s.blocked + s.duplicates + s.limited, text: parts.join(' · ') };
}

/** P88-15 / Q198: Free plan → settings read-only with an upgrade note. Unknown (not loaded) counts as included. */
export function guardLocked(features: FeatureAccess | undefined): boolean {
  return !!features && features.features.fake_order_guard === false;
}

// ---------- Blocked numbers (§10.1 41:11630) ----------

/** "5 returns at your shop" for automatic entries; the note (or "Blocked by hand") for manual ones. */
export function blockReason(b: Pick<BlockedNumber, 'reason' | 'note' | 'returned_count'>): { title: string; detail: string | null } {
  if (b.reason === 'repeat_returns') return { title: `${plural(b.returned_count, 'return', 'returns')} at your shop`, detail: b.note };
  return { title: b.note || 'Blocked by hand', detail: b.returned_count > 0 ? `${plural(b.returned_count, 'return', 'returns')} at your shop` : null };
}

/** "BLOCKED BY": Auto + rule name, or the staff member + role. */
export function blockedBy(b: Pick<BlockedNumber, 'source' | 'reason' | 'created_by'>): { who: string; role: string } {
  if (b.source === 'auto' || !b.created_by) return { who: 'Auto', role: b.reason === 'repeat_returns' ? 'Return rule' : 'Guard rule' };
  return { who: b.created_by.name.split(' ')[0] ?? b.created_by.name, role: b.created_by.role_label };
}

/** `01712•••678` / full local number when the API sends it (`customers.view`). */
export function displayPhone(b: Pick<BlockedNumber, 'phone' | 'phone_masked'>): string {
  if (!b.phone) return b.phone_masked;
  const m = /^880(1\d{3})(\d{6})$/.exec(b.phone);
  return m ? `0${m[1]}-${m[2]}` : b.phone;
}

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** ISO → "9 Nov 2026". */
export function longDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getDate()} ${SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

// ---------- Phone + note validation (dialogs) ----------

export function phoneError(input: string): string | null {
  if (!input.trim()) return 'Enter a phone number.';
  return normalizeBdPhone(input) ? null : 'Enter a Bangladeshi mobile number like 01712-345678.';
}

export function noteError(note: string): string | null {
  if (note.length > FRAUD_GUARD_NOTE_MAX) return `Keep the note under ${FRAUD_GUARD_NOTE_MAX} characters.`;
  if (Array.from(note).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return 'Remove special characters from the note.';
  return null;
}

// ---------- Decision log (§10.1 41:11740) ----------

export type EventIcon = 'phone' | 'card' | 'check' | 'alert' | 'orders' | 'unlock' | 'sms';

export const eventMeta: Record<FraudGuardEventType, { label: string; tone: BadgeTone; icon: EventIcon }> = {
  held: { label: 'Held for a call', tone: 'warning', icon: 'phone' },
  advance_asked: { label: 'Advance asked', tone: 'brand', icon: 'card' },
  advance_paid: { label: 'Advance paid', tone: 'success', icon: 'check' },
  released: { label: 'Released', tone: 'neutral', icon: 'unlock' },
  duplicate: { label: 'Duplicate caught', tone: 'neutral', icon: 'orders' },
  blocked_checkout: { label: 'Blocked', tone: 'danger', icon: 'alert' },
  limit_reached: { label: 'Limit reached', tone: 'danger', icon: 'alert' },
  auto_blocked: { label: 'Blocked', tone: 'danger', icon: 'alert' },
  otp_failed: { label: 'Code not sent', tone: 'warning', icon: 'sms' },
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Title + detail of a decision-log row. `detail` keys are optional; the row degrades to the type copy. */
export function eventText(e: FraudGuardEvent): { title: string; detail: string } {
  const d = e.detail ?? {};
  const rate = num(d.rate);
  const delivered = num(d.delivered);
  const total = num(d.total);
  const amount = num(d.amount);
  const rec = rate !== null && total ? `${rate}% delivered (${delivered ?? 0} of ${total})` : null;
  const who = e.order ? e.order.number : e.phone_masked;
  const reasons = Array.isArray(d.reasons) ? (d.reasons as GuardReason[]).filter((r) => typeof r === 'string') : [];
  switch (e.type) {
    case 'held':
      return { title: who, detail: reasons.length ? capitalise(reasons.map((r) => reasonText(r, { rate, record: total ? { total, delivered: delivered ?? 0, sources: [] } : null })).join(' · ')) : (rec ?? 'Held for a call') };
    case 'advance_asked':
      return { title: who, detail: [amount !== null ? `${formatBdt(amount)} payment link sent by SMS` : 'Payment link sent by SMS', rec ? `${rate}% delivered` : null].filter(Boolean).join(' · ') };
    case 'advance_paid':
      return { title: who, detail: `${amount !== null ? `${formatBdt(amount)} received` : 'Received'} through the gateway · auto-confirmed` };
    case 'released': {
      const by = str(d.by_name);
      return { title: who, detail: by ? `Hold released by ${by}` : 'Hold released' };
    }
    case 'duplicate': {
      const kept = str(d.duplicate_of_number);
      const hours = num(d.window_hours);
      return { title: kept && e.order ? `${e.order.number} → kept ${kept}` : who, detail: `Same phone, same product${hours ? ` within ${hours} hours` : ''}` };
    }
    case 'blocked_checkout':
      return { title: e.phone_masked, detail: 'Cash on delivery refused at checkout — the number is blocked' };
    case 'limit_reached': {
      const count = num(d.count);
      const limit = num(d.limit);
      return { title: e.phone_masked, detail: count && limit ? `${ordinal(count)} order today · limit is ${limit} per phone` : 'Daily order limit reached' };
    }
    case 'auto_blocked': {
      const returned = num(d.returned) ?? num(d.returned_count);
      return { title: e.phone_masked, detail: returned ? `${plural(returned, 'return', 'returns')} at your shop · blocked by the return rule` : 'Blocked by the return rule' };
    }
    case 'otp_failed':
      return { title: who, detail: 'The SMS code couldn’t be sent — the order was held for a call' };
  }
}

/** "13:18" today, else "9 Nov". */
export function eventTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === now.toDateString()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getDate()} ${SHORT[d.getMonth()]}`;
}
