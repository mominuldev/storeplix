import {
  AUTOMATION_LIMITS,
  AUTOMATION_ORDER_CHANNEL_CHIPS,
  RECIPE_MERGE_FIELDS,
  type Automation,
  type AutomationCondition,
  type AutomationConditionField,
  type AutomationMessage,
  type AutomationRun,
  type AutomationRunStep,
  type AutomationStatus,
  type FeatureAccess,
  type OrderChannel,
  type RecipeKey,
  type RunOutcomeReason,
  type RunStatus,
  type StepReason,
} from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { renderSms, type SampleContext, type SmsSample } from '../campaigns/campaigns';
import { formatBdt } from '../catalog/format';

// PHASE-8-6 §3–§10 pure helpers: plan lock, labels and tones, run/step lines, the condition catalogue (labels + ops),
// order-channel chips, the rendered SMS sample (8.5 renderer + `{cart_link}` / `{order_no}`, 3-part cap).

export const MAX_AUTOMATION_SMS_PARTS = AUTOMATION_LIMITS.sms_max_parts;
export const RECOVERY_PATH = '/marketing/automations/checkout-recovery';

/** P86-17: Free plan (no `sms_automation`) → plan note, create/enable disabled. Unknown features → not locked. */
export function automationsLocked(features: FeatureAccess | undefined): boolean {
  if (!features) return false;
  return features.features.sms_automation === false;
}

/** Editor for most recipes; checkout recovery has its own page (§10.3). */
export const automationPath = (a: Pick<Automation, 'id' | 'recipe'>) => (a.recipe === 'checkout_recovery' ? RECOVERY_PATH : `/marketing/automations/${a.id}`);

export const automationStatusMeta: Record<AutomationStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  on: { label: 'Automation on', tone: 'success' },
  off: { label: 'Off', tone: 'neutral' },
};

// ---------- runs + steps ----------

export const runStatusMeta: Record<RunStatus, { label: string; tone: BadgeTone }> = {
  running: { label: 'Running', tone: 'info' },
  waiting: { label: 'Waiting', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const outcomeReasonLabels: Record<RunOutcomeReason, string> = {
  conditions_not_met: 'Conditions not met',
  subject_missing: 'Subject no longer exists',
  no_eligible_address: 'No one to message',
  converted: 'Order placed',
  window_ended: 'Window ended',
  opted_out: 'Opted out',
  automation_off: 'Automation turned off',
  plan: 'Not in your plan',
  error: 'Something went wrong',
};

export const stepReasonLabels: Record<StepReason, string> = {
  not_eligible: 'not eligible',
  no_address: 'no phone or email',
  opted_out: 'opted out',
  frequency_cap: 'daily limit reached',
  allowance: 'out of allowance',
  coupon_inactive: 'coupon not active',
  no_customer: 'no customer',
  already_tagged: 'already tagged',
  tags_full: 'customer has 20 tags',
  no_recipients: 'no team member to email',
  provider_error: 'provider error',
  invalid_address: 'invalid address',
};

const channelWord = (c: AutomationRunStep['channel']) => (c === 'email' ? 'Email' : 'SMS');

/** One line per step (Recent runs, run log): "Sent to 01711-••••44", "Skipped · opted out", "Tagged VIP", … */
export function stepLine(s: AutomationRunStep): string {
  const reason = s.reason ? stepReasonLabels[s.reason] : null;
  if (s.status === 'skipped') return `Skipped · ${reason ?? 'skipped'}`;
  if (s.status === 'failed') return `${channelWord(s.channel)} failed${reason ? ` · ${reason}` : ''}`;
  if (s.status === 'unknown') return `${channelWord(s.channel)} result unknown · not retried`;
  if (s.status === 'sending') return `Sending ${channelWord(s.channel)}…`;
  switch (s.action) {
    case 'send_message':
      return s.masked_address ? `Sent to ${s.masked_address}` : `${channelWord(s.channel)} sent`;
    case 'add_tag':
      return `Tagged ${s.detail?.tag ?? ''}`.trim();
    case 'notify_team': {
      const n = s.detail?.recipients ?? 0;
      return `Emailed ${n} team ${n === 1 ? 'member' : 'members'}`;
    }
  }
}

/** First line under a run: the first step's outcome, else the run's own status/reason. */
export function runLine(r: AutomationRun): string {
  const first = r.steps[0];
  if (first) return stepLine(first);
  if (r.status === 'waiting') return r.resume_at ? 'Waiting for the next step' : 'Waiting';
  if (r.outcome_reason) return `${runStatusMeta[r.status].label} · ${outcomeReasonLabels[r.outcome_reason].toLowerCase()}`;
  return runStatusMeta[r.status].label;
}

export type RunIconKind = 'check' | 'refresh' | 'alert' | 'users' | 'mail';

/** §10.1 icon by outcome: check = completed with a message, refresh = waiting, alert = failed/skipped, users = tag, mail = notify. */
export function runIcon(r: AutomationRun): { kind: RunIconKind; tone: BadgeTone } {
  if (r.status === 'waiting' || r.status === 'running') return { kind: 'refresh', tone: 'brand' };
  if (r.status === 'failed' || r.status === 'skipped') return { kind: 'alert', tone: 'danger' };
  const done = r.steps.filter((s) => s.status === 'done');
  if (done.some((s) => s.action === 'notify_team')) return { kind: 'mail', tone: 'info' };
  if (done.some((s) => s.action === 'add_tag') && !done.some((s) => s.action === 'send_message')) return { kind: 'users', tone: 'brand' };
  if (r.status === 'stopped' && !r.conversion) return { kind: 'alert', tone: 'warning' };
  return { kind: 'check', tone: 'success' };
}

/** Recovery page "Recent carts" pill (§10.3). */
export function recoveryPill(r: AutomationRun): { label: string; tone: BadgeTone } {
  const sent = r.steps.filter((s) => s.action === 'send_message' && s.status === 'done');
  const last = sent[sent.length - 1];
  if (r.conversion) return { label: `Recovered · ${channelWord(last?.channel ?? 'sms')}`, tone: 'success' };
  if (r.outcome_reason === 'opted_out' || r.steps.some((s) => s.reason === 'opted_out')) return { label: 'Opted out', tone: 'danger' };
  if (r.status === 'waiting') return { label: `Waiting · step ${Math.min(2, sent.length + 1)}`, tone: 'warning' };
  if (r.status === 'skipped') {
    const reason = r.steps.find((s) => s.status === 'skipped')?.reason;
    return { label: `Skipped · ${reason ? stepReasonLabels[reason] : r.outcome_reason === 'conditions_not_met' ? 'risky' : 'no message'}`, tone: 'danger' };
  }
  if (r.status === 'failed') return { label: 'Failed', tone: 'danger' };
  if (last) return { label: `${channelWord(last.channel)} sent`, tone: 'info' };
  return { label: runStatusMeta[r.status].label, tone: runStatusMeta[r.status].tone };
}

/** "Jamdani Three-Piece × 2 · ৳ 4,860" (Recent carts second line). */
export function cartLine(r: AutomationRun): string {
  const c = r.context;
  const parts: string[] = [];
  if (c.first_product_name) parts.push(`${c.first_product_name}${c.cart_line_count && c.cart_line_count > 1 ? ` × ${c.cart_line_count}` : ''}`);
  const total = c.cart_total_amount ?? c.order_total_amount;
  if (total !== undefined) parts.push(formatBdt(total));
  return parts.join(' · ') || r.subject.label;
}

/** "2 min ago", "3 h ago", "Yesterday", "18 Nov" (store tz for dates). */
export function relativeTime(iso: string | null | undefined, tz: string, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(t));
}

/** "10:42" today, else "18 Nov" (store tz). */
export function clockOrDate(iso: string, tz: string, now = Date.now()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(x);
  if (day(d) === day(new Date(now))) return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' }).format(d);
}

// ---------- conditions (§5) ----------

export const conditionFieldLabels: Record<AutomationConditionField, string> = {
  'order.total_amount': 'Order total',
  'order.payment_method': 'Payment method',
  'order.channel': 'Order channel',
  'customer.tag': 'Customer tag',
  'customer.delivered_orders_count': 'Delivered orders',
  'customer.risk': 'Risk badge',
};

export const conditionOpLabels: Record<AutomationCondition['op'], string> = {
  gt: 'is above',
  lt: 'is below',
  is: 'is',
  in: 'is one of',
  has: 'has',
  not_has: 'doesn’t have',
  gte: 'is at least',
  is_not: 'is not',
};

/** A new condition row with a sensible default value. */
export function defaultCondition(field: AutomationConditionField): AutomationCondition {
  switch (field) {
    case 'order.total_amount':
      return { field, op: 'gt', value: 300_000 };
    case 'order.payment_method':
      return { field, op: 'is', value: 'cod' };
    case 'order.channel':
      return { field, op: 'in', value: ['website'] };
    case 'customer.tag':
      return { field, op: 'not_has', value: '' };
    case 'customer.delivered_orders_count':
      return { field, op: 'gte', value: 5 };
    case 'customer.risk':
      return { field, op: 'is_not', value: 'risky' };
  }
}

/** Fields the "+ Add condition" menu offers: the recipe's list minus those present; `order.channel` is the chips. */
export function addableConditions(allowed: readonly AutomationConditionField[], current: readonly AutomationCondition[], max: number = AUTOMATION_LIMITS.max_conditions): AutomationConditionField[] {
  if (current.length >= max) return [];
  const used = new Set(current.map((c) => c.field));
  return allowed.filter((f) => f !== 'order.channel' && f !== 'customer.risk' && f !== 'customer.delivered_orders_count' && !used.has(f));
}

export function conditionProblem(c: AutomationCondition): string | null {
  if (c.field === 'customer.tag' && !c.value.trim()) return 'Type a tag.';
  if (c.field === 'customer.tag' && c.value.length > AUTOMATION_LIMITS.tag_max) return `Keep tags under ${AUTOMATION_LIMITS.tag_max} characters.`;
  if (c.field === 'order.total_amount' && !(c.value >= 0)) return 'Enter an amount.';
  if (c.field === 'order.channel' && c.value.length === 0) return 'Pick at least one channel.';
  return null;
}

// ---------- order-channel chips (§5, Messenger / POS hidden) ----------

export const ORDER_CHANNEL_CHIPS = AUTOMATION_ORDER_CHANNEL_CHIPS;
const ALL_CHANNELS: OrderChannel[] = ORDER_CHANNEL_CHIPS.flatMap((c) => [...c.channels]);

/** Selected chip labels for a condition list: every chip when there is no `order.channel` condition. */
export function selectedChannelChips(conditions: readonly AutomationCondition[]): Set<string> {
  const c = conditions.find((x) => x.field === 'order.channel');
  if (!c || c.field !== 'order.channel') return new Set(ORDER_CHANNEL_CHIPS.map((x) => x.label));
  return new Set(ORDER_CHANNEL_CHIPS.filter((x) => x.channels.every((ch) => c.value.includes(ch))).map((x) => x.label));
}

/** Toggle one chip; all chips on → the condition is removed; the last chip can't be turned off. */
export function toggleChannelChip(conditions: readonly AutomationCondition[], label: string): AutomationCondition[] {
  const selected = selectedChannelChips(conditions);
  if (selected.has(label)) {
    if (selected.size === 1) return [...conditions];
    selected.delete(label);
  } else selected.add(label);
  const rest = conditions.filter((c) => c.field !== 'order.channel');
  if (selected.size === ORDER_CHANNEL_CHIPS.length) return rest;
  const value = ORDER_CHANNEL_CHIPS.filter((c) => selected.has(c.label)).flatMap((c) => [...c.channels]);
  return [{ field: 'order.channel', op: 'in', value: ALL_CHANNELS.filter((ch) => value.includes(ch)) }, ...rest];
}

// ---------- messages ----------

const MERGE_TAG_LABEL: Record<string, string> = {
  '{name}': '+ Customer name',
  '{cart_link}': '+ Cart link',
  '{product}': '+ Product',
  '{coupon}': '+ Coupon code',
  '{shop_link}': '+ Shop link',
  '{order_no}': '+ Order number',
};

/** Merge-tag buttons for a recipe (§8), in the 8.5 editor's `{field, label}` shape. */
export function mergeFieldsFor(recipe: RecipeKey): { field: string; label: string }[] {
  return RECIPE_MERGE_FIELDS[recipe].map((f) => ({ field: f.slice(1, -1), label: MERGE_TAG_LABEL[f] ?? `+ ${f}` }));
}

export function unknownAutomationFields(recipe: RecipeKey, text: string): string[] {
  const known = new Set(RECIPE_MERGE_FIELDS[recipe].map((f) => f.slice(1, -1)));
  return Array.from(new Set(Array.from(text.matchAll(/\{([^{}\s]*)\}/g), (m) => m[1]!))).filter((f) => !known.has(f));
}

export const SAMPLE_RECOVERY_CODE = 'Ab3dE5gH7k';
export const SAMPLE_ORDER_NO = 'GS-1048';

/**
 * Full SMS sample as the API renders it (P85-6 prefix + footer) with the automation fields: `{cart_link}` = the
 * `/r/{code}` link, `{order_no}` = a sample number, `{product}` = the sample product name (no picker).
 */
export function renderAutomationSms(body: string, ctx: Omit<SampleContext, 'channel' | 'product'> & { productName?: string | null }): SmsSample {
  const pre = body
    .replaceAll('{cart_link}', `${ctx.host}/r/${SAMPLE_RECOVERY_CODE}`)
    .replaceAll('{order_no}', SAMPLE_ORDER_NO)
    .replaceAll('{product}', ctx.productName ?? 'Jamdani Three-Piece');
  return renderSms(pre, { ...ctx, channel: 'sms', product: null });
}

/** Body with sample values for previews (no prefix/footer). */
export function previewText(body: string, ctx: { host: string; couponCode: string | null; productName?: string | null; language: 'bn' | 'en' }): string {
  return body
    .replaceAll('{cart_link}', `${ctx.host}/r/${SAMPLE_RECOVERY_CODE}`)
    .replaceAll('{order_no}', SAMPLE_ORDER_NO)
    .replaceAll('{product}', ctx.productName ?? 'Jamdani Three-Piece')
    .replaceAll('{coupon}', ctx.couponCode ?? 'CODE')
    .replaceAll('{shop_link}', ctx.host)
    .replaceAll('{name}', ctx.language === 'bn' ? 'নাসরিন' : 'Nasrin');
}

/** Client checks before Save (server stays authoritative). */
export function messageProblem(recipe: RecipeKey, m: AutomationMessage, smsParts: number | null, opts: { couponRequired?: boolean; maxParts?: number } = {}): string | null {
  const maxParts = opts.maxParts ?? MAX_AUTOMATION_SMS_PARTS;
  if (!m.body.trim()) return 'Write your message.';
  const unknown = unknownAutomationFields(recipe, m.body);
  if (unknown.length) return `Unknown tag ${unknown.map((u) => `{${u}}`).join(', ')}. Use the buttons below to add tags.`;
  if (opts.couponRequired && !m.body.includes('{coupon}')) return 'Add the {coupon} tag to this message.';
  if (m.channel === 'sms' && smsParts !== null && smsParts > maxParts) return `Too long: ${smsParts} SMS per person. Keep it to ${maxParts}.`;
  if (m.channel === 'email') {
    if (!m.subject?.trim()) return 'Add a subject.';
    if (m.subject.length > AUTOMATION_LIMITS.email_subject_max) return `Keep the subject under ${AUTOMATION_LIMITS.email_subject_max} characters.`;
    if (m.body.length > AUTOMATION_LIMITS.email_body_max) return `Keep the email under ${AUTOMATION_LIMITS.email_body_max.toLocaleString('en-US')} characters.`;
  }
  return null;
}

export const languageLabel = (l: 'bn' | 'en') => (l === 'bn' ? 'Bangla' : 'English');

/** "SMS · Bangla · 2 parts" / "Email · English". */
export function messageHead(m: AutomationMessage, parts: number): string {
  if (m.channel === 'email') return `Email · ${languageLabel(m.language)}`;
  return `SMS · ${languageLabel(m.language)} · ${parts} ${parts === 1 ? 'part' : 'parts'}`;
}

/** "% succeeded" hint: completed ÷ non-skipped (§10.1). */
export function succeededHint(pct: number | null): string {
  return pct === null ? 'No runs yet' : `${pct.toLocaleString('en-US', { maximumFractionDigits: 1 })}% succeeded`;
}

/** API error `details.fields` (automation_incomplete) → a readable line. */
export function incompleteMessage(details: Record<string, unknown> | undefined): string {
  const fields = details?.fields;
  if (Array.isArray(fields) && fields.length) return `Finish these first: ${fields.map((f) => String(f).replaceAll('_', ' ').replaceAll('.', ' › ')).join(', ')}.`;
  return 'Finish the settings first.';
}
