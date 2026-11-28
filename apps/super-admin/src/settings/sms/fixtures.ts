import type {
  PlatformSmsBroadcast,
  PlatformSmsBroadcastEstimate,
  PlatformSmsLogEntry,
  PlatformSmsMessageType,
  PlatformSmsTemplate,
  SmsProvider,
  SmsProviderDriverInfo,
  SmsProviderOverview,
} from '@storeplix/types';

// PHASE-8-9B test fixtures (Vitest and the Playwright mock). Shapes follow packages/types; values follow Figma.

export const reveDriver: SmsProviderDriverInfo = {
  code: 'revesms',
  name: 'REVE SMS',
  status: 'available',
  recommended: true,
  btrc_approved: true,
  price_masking_paisa: 40,
  price_non_masking_paisa: 25,
  features: { masking: true, dlr: false, unicode: true, balance: true },
  credential_fields: [
    { key: 'api_key', label: 'API key', secret: true, required: true, hint: null },
    { key: 'secret_key', label: 'API secret', secret: true, required: true, hint: null },
  ],
  settings_fields: [
    { key: 'account_id', label: 'Account ID', secret: false, required: false, hint: 'Shown on the REVE dashboard' },
    { key: 'base_url', label: 'API endpoint', secret: false, required: true, hint: 'Use an https:// address.' },
  ],
  default_base_url: 'https://smpp.revesms.com:7790',
};

export const drivers: SmsProviderDriverInfo[] = [
  reveDriver,
  { ...reveDriver, code: 'ssl_wireless', name: 'SSL Wireless', status: 'coming_soon', recommended: false, price_masking_paisa: 45, price_non_masking_paisa: 28 },
  { ...reveDriver, code: 'alpha_sms', name: 'Alpha SMS', status: 'coming_soon', recommended: false },
  { ...reveDriver, code: 'bulksmsbd', name: 'BulkSMSBD', status: 'coming_soon', recommended: false },
  {
    ...reveDriver,
    code: 'http',
    name: 'Other (HTTP API)',
    recommended: false,
    btrc_approved: false,
    price_masking_paisa: null,
    price_non_masking_paisa: null,
    features: { masking: true, dlr: false, unicode: true, balance: false },
    credential_fields: [],
    default_base_url: null,
  },
];

export function provider(overrides: Partial<SmsProvider> = {}): SmsProvider {
  return {
    id: 'PR1',
    driver: 'revesms',
    name: 'REVE SMS',
    role: 'primary',
    credentials_hint: { api_key: '••••3f9a', secret_key: '••••a91c' },
    settings: { account_id: 'STPX-2041', base_url: 'https://smpp.revesms.com/api/v2', http: null },
    default_sender_id: 'Storeplix',
    promotional_sender_id: 'SPXOffers',
    promotional_sender_status: 'approved',
    message_groups: ['shop', 'registration', 'billing', 'security', 'promotional'],
    rate_limit_per_minute: 300,
    failover_after_failures: 3,
    failover_timeout_seconds: 10,
    price_masking_paisa: 40,
    price_non_masking_paisa: 25,
    balance: {
      status: 'low',
      amount_paisa: 842_000,
      currency: 'BDT',
      fetched_at: '2026-11-28T03:45:00Z',
      approx_parts: 21_050,
      days_left: 3,
      spend_7d_paisa: 1_976_000,
      low_threshold_paisa: 1_000_000,
      alert_email: true,
      alert_in_app: true,
    },
    health: 'healthy',
    accepted_rate_24h: 99.1,
    last_sent_at: '2026-11-28T03:59:52Z',
    last_test: { at: '2026-11-28T03:02:00Z', status: 'passed', error_code: null, by: { id: 'U1', name: 'Sadia Ahmed' } },
    test_required: false,
    credentials_rotated_at: '2026-11-02T05:00:00Z',
    credentials_rotated_by: { id: 'U2', name: 'Rafiq Islam' },
    activated_at: '2026-10-12T05:00:00Z',
    created_at: '2026-10-12T04:00:00Z',
    revision: 4,
    ...overrides,
  };
}

export function overview(overrides: Partial<SmsProviderOverview> = {}): SmsProviderOverview {
  return {
    source: 'database',
    primary: provider(),
    failover: null,
    others: [],
    environment: null,
    failover_active: false,
    waiting: [],
    recent_errors: [
      {
        id: 'E1',
        at: '2026-11-28T04:42:00Z',
        provider: { id: 'PR1', name: 'REVE SMS' },
        error_code: 'provider_error',
        detail: 'Invalid number',
        type: 'phone_verification',
        to_masked: '01711-•••234',
        result: 'failed',
      },
    ],
    alerts: [],
    ...overrides,
  };
}

export const noneOverview = (): SmsProviderOverview =>
  overview({
    source: 'none',
    primary: null,
    recent_errors: [],
    waiting: [
      { group: 'registration', queued: 12, failed_24h: 0 },
      { group: 'billing', queued: 48, failed_24h: 0 },
      { group: 'security', queued: 0, failed_24h: 7 },
    ],
    alerts: [{ code: 'no_provider', severity: 'danger', message: 'No SMS provider — sign-in codes will fail', provider_id: null }],
  });

function template(language: 'bn' | 'en', body: string, overrides: Partial<PlatformSmsTemplate> = {}): PlatformSmsTemplate {
  return { language, body, default_body: body, is_custom: false, preview: body.replace(/\{[a-z_]+\}/g, 'X'), parts: 1, revision: 0, updated_at: null, updated_by: null, ...overrides };
}

export const messageTypes: PlatformSmsMessageType[] = [
  {
    type: 'welcome',
    group: 'registration',
    label: 'Welcome',
    trigger: 'A new merchant verifies their phone',
    locked: false,
    editable: true,
    enabled: true,
    sender: 'default',
    merge_fields: ['merchant_name', 'store_name', 'link'],
    required_fields: [],
    templates: [template('bn', 'Store Plix-এ স্বাগতম, {merchant_name}!'), template('en', 'Welcome to Store Plix, {merchant_name}! {store_name} is ready: {link}')],
    sent_this_month: 120,
  },
  {
    type: 'phone_verification',
    group: 'registration',
    label: 'Phone verification code',
    trigger: 'A merchant verifies a phone number',
    locked: true,
    editable: false,
    enabled: null,
    sender: 'default',
    merge_fields: ['otp'],
    required_fields: ['otp'],
    templates: [
      template('bn', 'Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.'),
      template('en', 'Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.'),
    ],
    sent_this_month: 900,
  },
  {
    type: 'invoice_issued',
    group: 'billing',
    label: 'Invoice issued',
    trigger: 'A renewal invoice is issued',
    locked: false,
    editable: true,
    enabled: true,
    sender: 'default',
    merge_fields: ['merchant_name', 'store_name', 'invoice_no', 'amount', 'due_date', 'plan', 'link'],
    required_fields: ['invoice_no', 'link'],
    templates: [
      template('bn', 'Store Plix: {plan} প্ল্যানের ইনভয়েস {invoice_no}, {amount} টাকা। পরিশোধ: {link}', { is_custom: true, revision: 2 }),
      template('en', 'Store Plix: Invoice {invoice_no} for Tk {amount} ({plan}) is due {due_date}. Pay: {link}'),
    ],
    sent_this_month: 300,
  },
  {
    type: 'sign_in_code',
    group: 'security',
    label: 'Sign-in code',
    trigger: 'A merchant signs in with a phone code',
    locked: true,
    editable: false,
    enabled: null,
    sender: 'default',
    merge_fields: ['otp'],
    required_fields: ['otp'],
    templates: [template('bn', 'Your Store Plix code is {otp}.'), template('en', 'Your Store Plix code is {otp}.')],
    sent_this_month: 2000,
  },
  {
    type: 'broadcast',
    group: 'promotional',
    label: 'Broadcasts',
    trigger: 'Staff send a broadcast',
    locked: false,
    editable: false,
    enabled: true,
    sender: 'promotional',
    merge_fields: ['merchant_name', 'store_name', 'plan', 'link'],
    required_fields: [],
    templates: [],
    sent_this_month: 50,
  },
];

export const messageTypesMeta = {
  kpis: { sent_this_month: 38_214, codes_this_month: 21_860, promotional_this_month: 6_412, cost_this_month_paisa: 1_528_600 },
  groups: [
    { group: 'registration' as const, sender_id: 'Storeplix', provider: { id: 'PR1', name: 'REVE SMS' }, rate_limit_per_minute: 300 },
    { group: 'billing' as const, sender_id: 'Storeplix', provider: { id: 'PR1', name: 'REVE SMS' }, rate_limit_per_minute: 300 },
    { group: 'security' as const, sender_id: 'Storeplix', provider: { id: 'PR1', name: 'REVE SMS' }, rate_limit_per_minute: 300 },
    { group: 'promotional' as const, sender_id: 'SPXOffers', provider: { id: 'PR1', name: 'REVE SMS' }, rate_limit_per_minute: 300 },
  ],
};

export function estimate(overrides: Partial<PlatformSmsBroadcastEstimate> = {}): PlatformSmsBroadcastEstimate {
  return {
    recipients: 1177,
    skipped: { opted_out: 96, no_verified_phone: 11, weekly_cap: 0, suspended: 0, duplicate: 0 },
    parts_bn: 2,
    parts_en: 1,
    parts_per_sms: 2,
    total_parts: 2354,
    cost_paisa: 94_200,
    balance_paisa: 842_000,
    balance_after_paisa: 747_800,
    below_alert: true,
    sender_id: 'SPXOffers',
    sender_status: 'approved',
    checks: { sending_hours: true, stop_footer: true, opt_outs_honoured: true, weekly_cap: 2 },
    ...overrides,
  };
}

export function broadcast(overrides: Partial<PlatformSmsBroadcast> = {}): PlatformSmsBroadcast {
  return {
    id: 'B1',
    name: 'Eid offer 2026',
    body_bn: '{merchant_name}, ঈদ অফার! Growth প্ল্যানে ২০% ছাড়: {link}',
    body_en: '{merchant_name}, Eid offer: 20% off Growth: {link}',
    audience: { kind: 'plan', plans: ['starter'] },
    status: 'draft',
    scheduled_at: '2026-11-30T04:00:00Z',
    started_at: null,
    finished_at: null,
    estimate: null,
    counts: { recipients: 0, sent: 0, failed: 0, skipped: 0, pending: 0 },
    created_by: { id: 'U1', name: 'Sadia Ahmed' },
    confirmed_by: null,
    confirmed_at: null,
    cancelled_at: null,
    failure_reason: null,
    revision: 1,
    created_at: '2026-11-28T03:00:00Z',
    ...overrides,
  };
}

export const audiences = {
  all: 3206,
  plans: [
    { code: 'free', name: 'Free', count: 1412 },
    { code: 'starter', name: 'Starter', count: 1284 },
    { code: 'growth', name: 'Growth', count: 371 },
  ],
  statuses: { active: 2980, trialing: 214, past_due: 12, cancelled: 0, expired: 0 },
  trial_ending: 41,
};

export function logEntry(overrides: Partial<PlatformSmsLogEntry> = {}): PlatformSmsLogEntry {
  return {
    id: 'M1',
    created_at: '2026-11-28T09:42:00Z',
    to_masked: '01711-•••678',
    merchant: { id: 'T1', name: 'Mugdho Fashion', slug: 'mugdho' },
    type: 'sign_in_code',
    group: 'security',
    status: 'sent',
    body_preview: null,
    body_hidden: true,
    parts: 1,
    provider: { id: 'PR1', name: 'REVE SMS' },
    error_code: null,
    ...overrides,
  };
}
