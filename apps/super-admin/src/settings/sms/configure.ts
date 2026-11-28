import {
  SMS_MESSAGE_GROUPS,
  SMS_PRIMARY_REQUIRED_GROUPS,
  SMS_SENDER_ID_PATTERN,
  type CreateSmsProviderInput,
  type SmsHttpMapping,
  type SmsMessageGroup,
  type SmsProviderDriverCode,
  type SmsProviderDriverInfo,
} from '@storeplix/types';
import { parseMoney } from '@storeplix/ui';
import { isHttpsUrl } from './format';

// PHASE-8-9B §11.2 configure-drawer form state and client checks (pure; unit-tested). The server re-validates.

export type Step = 1 | 2 | 3 | 4;

export interface HttpCredRow {
  key: string;
  value: string;
  param: string;
}

const HTTP_KEY = /^[a-z_]{2,32}$/;

export interface ConfigureState {
  driver: SmsProviderDriverCode | null;
  name: string;
  credentials: Record<string, string>;
  httpCreds: HttpCredRow[];
  accountId: string;
  baseUrl: string;
  http: Omit<SmsHttpMapping, 'credential_params'>;
  role: 'primary' | 'failover';
  groups: SmsMessageGroup[];
  defaultSender: string;
  promoSender: string;
  promoStatus: '' | 'approved' | 'pending';
  rateLimit: string;
  failAfter: string;
  timeout: string;
  priceMasking: string;
}

export function initialConfigureState(role: 'primary' | 'failover'): ConfigureState {
  return {
    driver: null,
    name: '',
    credentials: {},
    httpCreds: [{ key: 'api_key', value: '', param: 'api_key' }],
    accountId: '',
    baseUrl: '',
    http: { method: 'POST', body_format: 'json', to_param: 'to', text_param: 'message', sender_param: 'sender', success_path: 'status', success_value: '0', message_id_path: null },
    role,
    groups: role === 'primary' ? [...SMS_MESSAGE_GROUPS] : [...SMS_PRIMARY_REQUIRED_GROUPS],
    defaultSender: 'Storeplix',
    promoSender: '',
    promoStatus: '',
    rateLimit: '300',
    failAfter: '3',
    timeout: '10',
    priceMasking: '',
  };
}

/** Client checks per step (the server re-validates everything). Keys = field ids, values = messages. */
export function stepErrors(step: Step, s: ConfigureState, driver: SmsProviderDriverInfo | undefined): Record<string, string> {
  const e: Record<string, string> = {};
  if (step === 1) {
    if (!driver) e.driver = 'Pick a provider.';
    else if (driver.status !== 'available') e.driver = `${driver.name} is coming soon. Use “Other (HTTP API)” for it meanwhile.`;
  }
  if (step === 2 && driver) {
    const name = s.name.trim();
    if (name.length < 2 || name.length > 60) e.name = 'Use 2–60 characters.';
    if (driver.code === 'http') {
      if (s.httpCreds.length < 1 || s.httpCreds.length > 5) e.httpCreds = 'Add 1–5 credential fields.';
      const keys = s.httpCreds.map((r) => r.key.trim());
      s.httpCreds.forEach((r, i) => {
        if (!HTTP_KEY.test(r.key.trim())) e[`httpKey${i}`] = 'Lowercase letters and _ (2–32).';
        else if (keys.indexOf(r.key.trim()) !== i) e[`httpKey${i}`] = 'Each field needs its own name.';
        if (!r.value.trim()) e[`httpValue${i}`] = 'Paste the value.';
        if (!r.param.trim()) e[`httpParam${i}`] = 'Enter the request parameter name.';
      });
      for (const k of ['to_param', 'text_param', 'sender_param', 'success_path', 'success_value'] as const) {
        if (!String(s.http[k] ?? '').trim()) e[k] = 'Required.';
      }
    } else {
      for (const f of driver.credential_fields) if (f.required && !s.credentials[f.key]?.trim()) e[f.key] = 'Paste the value from the provider portal.';
    }
    if (driver.settings_fields.some((f) => f.key === 'account_id' && f.required) && !s.accountId.trim()) e.account_id = 'Required.';
    if (!isHttpsUrl(s.baseUrl)) e.base_url = 'Use an https:// address.';
  }
  if (step === 3) {
    if (!s.groups.length) e.groups = 'Pick at least one message type.';
    if (s.role === 'primary' && SMS_PRIMARY_REQUIRED_GROUPS.some((g) => !s.groups.includes(g))) e.groups = 'The primary must send shop, registration, billing and sign-in SMS.';
    if (!SMS_SENDER_ID_PATTERN.test(s.defaultSender.trim())) e.defaultSender = '3–11 letters and numbers.';
    if (s.promoSender.trim() && !SMS_SENDER_ID_PATTERN.test(s.promoSender.trim())) e.promoSender = '3–11 letters and numbers.';
    const rate = Number(s.rateLimit);
    if (!Number.isInteger(rate) || rate < 1 || rate > 6000) e.rateLimit = 'Between 1 and 6,000 per minute.';
    const fail = Number(s.failAfter);
    if (!Number.isInteger(fail) || fail < 1 || fail > 10) e.failAfter = '1–10';
    const t = Number(s.timeout);
    if (!Number.isInteger(t) || t < 3 || t > 30) e.timeout = '3–30 s';
    const price = parseMoney(s.priceMasking);
    if (price !== null && Number.isNaN(price)) e.priceMasking = 'Enter an amount like 0.40.';
  }
  return e;
}

/** The connection part of the form: a change here needs a fresh draft (credentials can't be patched). */
export function connectionKey(s: ConfigureState): string {
  return JSON.stringify([s.driver, s.credentials, s.httpCreds, s.accountId.trim(), s.baseUrl.trim(), s.http]);
}

export function toCreateInput(s: ConfigureState, driver: SmsProviderDriverInfo): CreateSmsProviderInput {
  const isHttp = driver.code === 'http';
  const credentials = isHttp
    ? Object.fromEntries(s.httpCreds.map((r) => [r.key.trim(), r.value]))
    : Object.fromEntries(driver.credential_fields.map((f) => [f.key, s.credentials[f.key] ?? '']).filter(([, v]) => v !== ''));
  const price = parseMoney(s.priceMasking);
  return {
    driver: driver.code,
    name: s.name.trim(),
    credentials,
    settings: {
      account_id: s.accountId.trim() || null,
      base_url: s.baseUrl.trim(),
      http: isHttp ? { ...s.http, message_id_path: s.http.message_id_path?.trim() || null, credential_params: Object.fromEntries(s.httpCreds.map((r) => [r.key.trim(), r.param.trim()])) } : null,
    },
    default_sender_id: s.defaultSender.trim(),
    promotional_sender_id: s.promoSender.trim() || null,
    promotional_sender_status: s.promoSender.trim() ? s.promoStatus || 'pending' : null,
    message_groups: s.groups,
    rate_limit_per_minute: Number(s.rateLimit),
    failover_after_failures: Number(s.failAfter),
    failover_timeout_seconds: Number(s.timeout),
    price_masking_paisa: price === null || Number.isNaN(price) ? driver.price_masking_paisa : price,
    price_non_masking_paisa: driver.price_non_masking_paisa,
  };
}

