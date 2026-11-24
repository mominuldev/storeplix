import type {
  Automation,
  AutomationDetail,
  AutomationDryRun,
  AutomationKpis,
  AutomationRun,
  AutomationStats,
  RecipeCard,
  RecipeSchema,
} from '@storeplix/types';
import { jsonResponse } from '../test/utils';
import { features } from './phase7.fixtures';
import { overview } from './phase8-5.fixtures';

// PHASE-8-6 §9.2 / §11.1 shapes with Figma 140:30336 / 141:30622 / 71:20614 sample data.

export const starterAuto = () => {
  const f = features({ plan_code: 'starter' }, { campaign_sms_per_month: { limit: 1000, used: 20 }, campaign_emails_per_month: { limit: 5000, used: 0 } });
  return { ...f, features: { ...f.features, sms_automation: true } };
};
export const freePlan = () => features();

const base = { paused_reason: null, runs_7d: 0, last_run_at: null, created_at: '2026-11-18T08:00:00Z', updated_at: '2026-11-18T08:00:00Z', revision: 1 } as const;

export const recovery = (o: Partial<Extract<Automation, { recipe: 'checkout_recovery' }>> = {}): Extract<Automation, { recipe: 'checkout_recovery' }> => ({
  ...base,
  id: 'A1',
  recipe: 'checkout_recovery',
  name: 'Win back unfinished orders',
  status: 'on',
  trigger_label: 'Checkout left 30 min',
  action_label: 'Reminder SMS',
  runs_7d: 483,
  last_run_at: '2026-11-24T05:55:00Z',
  settings: {
    delay_minutes: 30,
    step1: { enabled: true, message: { channel: 'sms', language: 'bn', body: 'আপনার কার্টে {product} অপেক্ষা করছে! অর্ডার শেষ করুন: {cart_link}', subject: null } },
    wait_hours: 24,
    step2: { enabled: true, coupon_id: 'CP1', message: { channel: 'sms', language: 'bn', body: '{name}, ৪৮ ঘণ্টার জন্য ১০% ছাড় — কোড {coupon} {cart_link}', subject: null } },
    exit_days: 3,
    skip_risky: true,
  },
  ...o,
});

export const thankYou = (o: Partial<Extract<Automation, { recipe: 'thank_you' }>> = {}): Extract<Automation, { recipe: 'thank_you' }> => ({
  ...base,
  id: 'A2',
  recipe: 'thank_you',
  name: 'Thank-you message',
  status: 'draft',
  trigger_label: 'Delivered',
  action_label: 'Thank-you SMS',
  settings: { delay_hours: 0, message: { channel: 'sms', language: 'en', body: 'Hi {name}, thanks for order {order_no}!', subject: null }, conditions: [] },
  ...o,
});

export const lowStock = (o: Partial<Extract<Automation, { recipe: 'low_stock' }>> = {}): Extract<Automation, { recipe: 'low_stock' }> => ({
  ...base,
  id: 'A3',
  recipe: 'low_stock',
  name: 'Low stock alert',
  status: 'off',
  trigger_label: 'Stock below threshold',
  action_label: 'Email the team',
  runs_7d: 4,
  last_run_at: '2026-11-23T05:00:00Z',
  settings: {},
  ...o,
});

export const recipes = (added: Partial<Record<RecipeCard['recipe'], boolean>> = { checkout_recovery: true, thank_you: true, low_stock: true }): RecipeCard[] => [
  { recipe: 'checkout_recovery', name: 'Win back unfinished orders', description: 'Remind buyers who left checkout.', trigger_label: 'Checkout left 30 min', action_label: 'Reminder SMS', icon: 'cart', added: !!added.checkout_recovery },
  { recipe: 'thank_you', name: 'Thank-you message', description: 'When delivered, send a thank-you SMS.', trigger_label: 'Delivered', action_label: 'Thank-you SMS', icon: 'megaphone', added: !!added.thank_you },
  { recipe: 'vip_tag', name: 'Tag VIP buyers', description: 'After 5 delivered orders, add the VIP tag and a coupon.', trigger_label: '5th delivery', action_label: 'Tag VIP + coupon', icon: 'users', added: !!added.vip_tag },
  { recipe: 'return_flag', name: 'Handle returns', description: 'Flag buyers whose parcel came back.', trigger_label: 'Parcel returned', action_label: 'Flag buyer', icon: 'refresh', added: !!added.return_flag },
  { recipe: 'low_stock', name: 'Low stock alert', description: 'Email the team when stock runs low.', trigger_label: 'Stock below threshold', action_label: 'Email the team', icon: 'package', added: !!added.low_stock },
];

export const kpis = (o: Partial<AutomationKpis> = {}): AutomationKpis => ({
  active: 1, drafts: 1, total: 3, runs_7d: 1284, runs_7d_succeeded_pct: 99.6, messages_sent_month: 312, carts_recovered_30d: 58, recovered_revenue_30d: 9_240_000, ...o,
});

export const run = (o: Partial<AutomationRun> = {}): AutomationRun => ({
  id: 'R1',
  automation: { id: 'A1', recipe: 'checkout_recovery', name: 'Win back unfinished orders' },
  trigger: 'checkout.abandoned',
  status: 'completed',
  outcome_reason: null,
  outcome_detail: null,
  subject: { type: 'cart', id: 'CART1', label: 'Cart · 2 items' },
  contact: { masked_address: '01711-••••44', name: 'Nasrin Akter' },
  context: { cart_line_count: 2, cart_total_amount: 486_000, first_product_name: 'Jamdani Three-Piece', first_product_image_url: null, currency: 'BDT' },
  steps: [{ index: 0, action: 'send_message', status: 'done', reason: null, channel: 'sms', masked_address: '01711-••••44', parts: 2, detail: { message_step: 1 }, executed_at: '2026-11-24T04:42:00Z' }],
  started_at: '2026-11-24T04:41:00Z',
  resume_at: null,
  finished_at: '2026-11-24T04:42:00Z',
  conversion: { order: { id: 'O1', number: 'GS-1048', total_amount: 486_000 } },
  ...o,
});

export const runs: AutomationRun[] = [
  run(),
  run({ id: 'R2', status: 'waiting', conversion: null, finished_at: null, resume_at: '2026-11-25T04:42:00Z', contact: { masked_address: '01822-••••18', name: 'Tanvir Hasan' } }),
  run({
    id: 'R3',
    status: 'skipped',
    outcome_reason: 'no_eligible_address',
    outcome_detail: null,
    conversion: null,
    contact: { masked_address: '01911-••••22', name: null },
    steps: [{ index: 0, action: 'send_message', status: 'skipped', reason: 'opted_out', channel: 'sms', masked_address: '01911-••••22', parts: 0, detail: null, executed_at: '2026-11-24T03:00:00Z' }],
  }),
  run({
    id: 'R4',
    automation: { id: 'A3', recipe: 'low_stock', name: 'Low stock alert' },
    trigger: 'stock.low',
    subject: { type: 'inventory', id: 'I1', label: 'Silk Saree · Red' },
    contact: null,
    conversion: null,
    steps: [{ index: 0, action: 'notify_team', status: 'done', reason: null, channel: null, masked_address: null, parts: 0, detail: { recipients: 2 }, executed_at: '2026-11-24T02:00:00Z' }],
  }),
];

export const schemaThankYou: RecipeSchema = {
  trigger: 'order.delivered',
  trigger_description: 'When the courier marks an order delivered.',
  allowed_conditions: ['order.total_amount', 'order.payment_method', 'order.channel', 'customer.tag'],
  max_conditions: 5,
  steps: [
    { kind: 'wait', title: 'Wait', description: 'Send right away or a few hours later.', optional: true, message_step: null },
    { kind: 'send_message', title: 'Send a thank-you', description: 'SMS or email to the buyer.', optional: false, message_step: 1 },
  ],
  merge_fields: ['{name}', '{order_no}', '{product}', '{shop_link}'],
  sms_max_parts: 3,
};

export const thankYouDetail = (o: Partial<AutomationDetail> = {}): AutomationDetail =>
  ({ ...thankYou(), recipe_schema: schemaThankYou, stats_7d: { runs: 23, completed: 17, skipped: 6, stopped: 0, failed: 0 }, last_edited_by: { id: 'U1', name: 'Rafiqul Alam' }, ...o }) as AutomationDetail;

export const recoveryDetail = (o: Partial<AutomationDetail> = {}): AutomationDetail =>
  ({
    ...recovery(),
    recipe_schema: { ...schemaThankYou, trigger: 'checkout.abandoned', allowed_conditions: ['customer.risk'], merge_fields: ['{name}', '{cart_link}', '{product}', '{coupon}', '{shop_link}'] },
    stats_7d: { runs: 483, completed: 300, skipped: 20, stopped: 160, failed: 3 },
    last_edited_by: null,
    ...o,
  }) as AutomationDetail;

export const stats = (): AutomationStats => ({
  days: 14,
  steps: [
    { step: 1, sent: 284, recovered: 31, revenue_amount: 4_870_000 },
    { step: 2, sent: 196, recovered: 27, revenue_amount: 4_370_000 },
  ],
  daily: Array.from({ length: 14 }, (_, i) => ({ date: `2026-11-${String(11 + i).padStart(2, '0')}`, recovered: (i * 3) % 7, revenue_amount: 100_000 * i })),
  kpis: { carts_left_behind: 312, carts_left_behind_amount: 48_620_000, recovered: 58, recovery_rate_pct: 18.6, revenue_amount: 9_240_000, average_recovered_amount: 159_300, messages_sent_month: 480 },
  currency: 'BDT',
});

export const dryRun = (): AutomationDryRun => ({
  subject: { type: 'order', id: 'O7', label: 'GS-1047' },
  conditions: [
    { label: 'Order total ৳ 3,980 is above ৳ 3,000', passed: true, detail: null },
    { label: 'Payment method is Cash on delivery', passed: false, detail: 'paid online' },
  ],
  steps: [{ index: 0, action: 'send_message', would: 'send', reason: null, rendered: { channel: 'sms', subject: null, text: 'Mugdho Fashion: Hi Rakib, thanks for order GS-1047!', parts: 1 } }],
});

const cursorPage = (rows: unknown[]) => ({ data: rows, meta: { next_cursor: null, prev_cursor: null, per_page: 50 } });
const emptyPage = { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1 } };

export function automationRoutes(o: { features?: ReturnType<typeof features>; list?: Automation[]; recipes?: RecipeCard[]; runs?: AutomationRun[] } = {}) {
  return {
    'GET /features': jsonResponse(200, { data: o.features ?? starterAuto() }),
    'GET /stores/S1/automations': jsonResponse(200, { data: o.list ?? [recovery(), thankYou(), lowStock()], meta: { recipes: o.recipes ?? recipes(), kpis: kpis() } }),
    'GET /stores/S1/automation-runs': jsonResponse(200, cursorPage(o.runs ?? runs)),
    'GET /stores/S1/automations/A1': jsonResponse(200, { data: recoveryDetail() }),
    'GET /stores/S1/automations/A1/stats': jsonResponse(200, { data: stats() }),
    'GET /stores/S1/automations/A2': jsonResponse(200, { data: thankYouDetail() }),
    'GET /stores/S1/marketing/overview': jsonResponse(200, { data: overview() }),
    'GET /stores/S1/coupons': jsonResponse(200, {
      data: [{ id: 'CP1', code: 'COMEBACK10', usage_per_customer: 2, ends_at: null, type: 'percentage', percent_bps: 1000, amount: null, status: 'active' }],
      meta: { current_page: 1, per_page: 50, total: 1, last_page: 1, counts: { all: 1, active: 1, scheduled: 0, expired: 0 } },
    }),
    'GET /stores/S1/orders': jsonResponse(200, { ...emptyPage, meta: { ...emptyPage.meta, counts: {} } }),
    'GET /stores/S1/returns': jsonResponse(200, { ...emptyPage, meta: { ...emptyPage.meta } }),
  };
}
