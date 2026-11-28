import type {
  BillingInvoiceSummary,
  SmsCreditAccount,
  SmsCreditLedgerEntry,
  SmsLogEntry,
  SmsOverview,
  SmsSenderIdList,
  SmsSenderIdRequest,
  SmsTemplate,
  SmsTemplateKey,
} from '@storeplix/types';

// PHASE-8-9A fixtures (shapes from packages/types, openapi 1.23.0).

export const allCan = {
  edit_templates: true,
  send_test: true,
  view_log: true,
  view_sender_ids: true,
  request_sender_id: true,
  view_credit_history: true,
  buy_credits: true,
  edit_low_credit_alert: true,
};

export function overview(o: Partial<SmsOverview> = {}): SmsOverview {
  return {
    gateway: { provider: 'revesms', name: 'REVE SMS', status: 'connected', active_since: '2026-10-12T04:00:00Z', last_sent_at: new Date(Date.now() - 3 * 60_000).toISOString() },
    sender: { type: 'shared', sender_id: null, pending_request: null },
    language: 'bn',
    allowance: {
      transactional: { limit: 500, used: 240, remaining: 260, unit: 'messages' },
      marketing: { limit: 1000, used: 100, remaining: 900, unit: 'parts' },
    },
    credits: { balance: 1240, status: 'healthy', estimated_days_left: 9, low_credit_threshold: 200 },
    this_month: { messages_sent: 2860, messages_failed: 40, messages_skipped: 0, sent_success_rate: 0.986, credits_used: 4410, otp_sent: 312 },
    quiet_hours: { from: '21:00', to: '09:00', timezone: 'Asia/Dhaka' },
    can: { ...allCan },
    ...o,
  };
}

const LABELS: Record<SmsTemplateKey, string> = {
  order_placed: 'Order received',
  order_confirmed: 'Order confirmed',
  order_shipped: 'Shipped',
  order_cancelled: 'Order cancelled',
  order_updated: 'Order updated',
  payment_link: 'Payment link',
  pos_receipt: 'POS receipt',
  checkout_otp: 'Checkout code',
};

export function template(key: SmsTemplateKey, language: 'bn' | 'en', o: Partial<SmsTemplate> = {}): SmsTemplate {
  const body = language === 'en' ? `{shop}: Order {number} is confirmed.` : `{shop}: আপনার অর্ডার {number} কনফার্ম হয়েছে।`;
  return {
    key,
    language,
    label: LABELS[key],
    body,
    default_body: body,
    is_custom: false,
    editable: key !== 'checkout_otp',
    enabled: key === 'pos_receipt' || key === 'checkout_otp' ? null : true,
    merge_fields: key === 'checkout_otp' ? ['shop', 'code'] : key === 'payment_link' ? ['first_name', 'shop', 'number', 'amount', 'url'] : ['first_name', 'shop', 'number', 'total', 'due', 'track_url'],
    required_fields: key === 'payment_link' ? ['url'] : [],
    preview: { text: language === 'en' ? `Mugdho Fashion: Order MU-1042 is confirmed (${key}).` : `Mugdho Fashion: আপনার অর্ডার MU-1042 কনফার্ম হয়েছে। (${key})`, parts: 1, encoding: language === 'en' ? 'gsm7' : 'ucs2', characters: 40 },
    updated_at: null,
    updated_by: null,
    revision: 0,
    ...o,
  };
}

export function templates(over: (t: SmsTemplate) => SmsTemplate = (t) => t): SmsTemplate[] {
  const keys: SmsTemplateKey[] = ['order_placed', 'order_confirmed', 'order_shipped', 'order_cancelled', 'order_updated', 'payment_link', 'pos_receipt', 'checkout_otp'];
  return keys.flatMap((k) => [over(template(k, 'bn')), over(template(k, 'en'))]);
}

export function senderRequest(o: Partial<SmsSenderIdRequest> = {}): SmsSenderIdRequest {
  return {
    id: 'SID1',
    sender_id: 'MUGDHO',
    status: 'pending',
    business_name: 'Mugdho Fashion House',
    uses: ['order_updates', 'otp'],
    note: null,
    document: { mime: 'application/pdf', size_bytes: 1_200_000, filename: 'trade-licence.pdf' },
    requested_by: { id: 'U1', name: 'Rafiq Ahmed' },
    requested_at: '2026-11-24T09:40:00Z',
    reviewed_at: null,
    decision_reason: null,
    ...o,
  };
}

export const senderList = (o: Partial<SmsSenderIdList> = {}): SmsSenderIdList => ({ active: null, pending: null, history: [], ...o });

export function logEntry(o: Partial<SmsLogEntry> = {}): SmsLogEntry {
  return {
    id: 'M1',
    created_at: new Date().toISOString(),
    to_masked: '01711-•••211',
    purpose: 'order_placed',
    kind: 'transactional',
    status: 'sent',
    parts: 2,
    charged_from: 'allowance',
    sender_id: null,
    body_preview: 'প্রিয় রাকিব, আপনার অর্ডার #1042 পেয়েছি।',
    error_code: null,
    reference: { type: 'order', id: 'O1', label: 'MU-1042' },
    ...o,
  };
}

export const cursorMeta = (o: { next_cursor?: string | null; prev_cursor?: string | null } = {}) => ({ next_cursor: null, prev_cursor: null, per_page: 50, ...o });

export function account(o: Partial<SmsCreditAccount> = {}): SmsCreditAccount {
  return {
    balance: 980,
    status: 'healthy',
    estimated_days_left: 9,
    low_credit_threshold: 200,
    packs: [
      { code: 'credits_1000', credits: 1000, price_amount: 35_000, currency: 'BDT' },
      { code: 'credits_5000', credits: 5000, price_amount: 160_000, currency: 'BDT' },
      { code: 'credits_10000', credits: 10000, price_amount: 300_000, currency: 'BDT' },
    ],
    providers: ['bkash', 'sslcommerz'],
    open_invoice: null,
    last_purchase_at: null,
    ...o,
  };
}

export function smsInvoice(o: Partial<BillingInvoiceSummary> = {}): BillingInvoiceSummary {
  return {
    id: 'INV1',
    number: 'SP-2026-0042',
    kind: 'sms_credits',
    status: 'paid',
    description: 'SMS credits · 1,000',
    total_amount: 35_000,
    currency: 'BDT',
    issued_at: '2026-11-12T05:00:00Z',
    due_at: '2026-11-13T05:00:00Z',
    paid_at: '2026-11-12T05:01:00Z',
    is_overdue: false,
    can_pay: false,
    ...o,
  };
}

export function ledgerEntry(o: Partial<SmsCreditLedgerEntry> = {}): SmsCreditLedgerEntry {
  return { id: 'L1', type: 'purchase', credits: 1000, balance_after: 1000, created_at: '2026-11-12T05:01:00Z', invoice: { id: 'INV1', number: 'SP-2026-0042' }, sms_message_id: null, reason: null, ...o };
}

export const pageMeta = { current_page: 1, last_page: 1, per_page: 10, total: 1, providers: ['bkash', 'sslcommerz'] };
