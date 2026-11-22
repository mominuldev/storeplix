import type { CourierAccount, CourierProvider, CourierSettings, IntegrationStatus } from '@storeplix/types';
import type { CredentialField } from '../payments/gateways';

// Phase 5b-3 courier copy and pure helpers (PHASE-5B §1.C P5B-31/32/37, §4.6, §10; Figma 14:980, 22:1181, 31:2905,
// 152:34534, onboarding 45:8086 / 50:604).

export const COURIERS: CourierProvider[] = ['steadfast', 'pathao', 'redx'];

export interface CourierMeta {
  name: string;
  short: string;
  /** Integrations card capability line (14:980). */
  capability: string;
  /** Onboarding 06 card hint (45:8086). Default per §10: no "COD settled in 48 h" marketing claim. */
  onboardingHint: string;
  portalHint: string;
  /** Where the merchant pastes our webhook URL + secret (P5B-37); null = polling only (RedX until verified). */
  webhookHint: string | null;
  /** Name of the secret in the courier panel. */
  secretLabel: string;
  fields: CredentialField[];
}

export const courierMeta: Record<CourierProvider, CourierMeta> = {
  steadfast: {
    name: 'Steadfast Courier',
    short: 'Steadfast',
    capability: 'Booking, bulk booking, status sync',
    onboardingHint: 'Nationwide · pickup from your door · book parcels and track them here',
    portalHint: 'Find these in the Steadfast merchant panel → API.',
    webhookHint: 'Paste this URL and the Bearer token in Steadfast → Settings → Webhook.',
    secretLabel: 'Bearer token',
    fields: [
      { key: 'api_key', label: 'API key', max: 128, secret: false },
      { key: 'secret_key', label: 'Secret key', max: 128, secret: true },
    ],
  },
  pathao: {
    name: 'Pathao Courier',
    short: 'Pathao',
    capability: 'Booking, area lookup, status webhooks',
    onboardingHint: 'Fast inside Dhaka · book parcels and track them here',
    portalHint: 'Find these in the Pathao merchant panel → Developer API. Username is your Pathao login email.',
    webhookHint: 'Paste this URL and the secret in Pathao → Developer API → Webhook.',
    secretLabel: 'Webhook secret',
    fields: [
      { key: 'client_id', label: 'Client ID', max: 128, secret: false },
      { key: 'client_secret', label: 'Client secret', max: 128, secret: true },
      { key: 'username', label: 'Username (email)', max: 191, secret: false },
      { key: 'password', label: 'Password', max: 128, secret: true },
    ],
  },
  redx: {
    name: 'RedX',
    short: 'RedX',
    capability: 'Booking and tracking',
    onboardingHint: '64 districts · book parcels and track them here',
    portalHint: 'Find the API access token in the RedX merchant panel → Developer API.',
    webhookHint: null,
    secretLabel: 'Secret',
    fields: [{ key: 'access_token', label: 'API access token', max: 2048, secret: true }],
  },
};

export function courierStatusMeta(status: IntegrationStatus): { label: string; tone: 'success' | 'danger' | 'neutral' } {
  if (status === 'connected') return { label: 'Connected', tone: 'success' };
  if (status === 'error') return { label: 'Needs attention', tone: 'danger' };
  return { label: 'Not connected', tone: 'neutral' };
}

export const courierConnected = (a: Pick<CourierAccount, 'status'> | undefined) => a?.status === 'connected' || a?.status === 'error';

/** Always one entry per provider, in display order (absent ones come back `not_connected` from the API). */
export function couriersByProvider(list: CourierAccount[] | undefined): Record<CourierProvider, CourierAccount | undefined> {
  return { steadfast: list?.find((a) => a.provider === 'steadfast'), pathao: list?.find((a) => a.provider === 'pathao'), redx: list?.find((a) => a.provider === 'redx') };
}

// ---------- Booking rules (22:1181, P5B-32) ----------

export const DEFAULT_DESCRIPTION = '{items} · {order_no}';
export const DESCRIPTION_MAX = 120;
export const DESCRIPTION_VARIABLES = ['{items}', '{order_no}'] as const;
const SAMPLE = { items: 'Jamdani Three-Piece ×2, Cotton Kurti', order_no: 'GS-1039' };

/** The label text for a sample order, cut to what couriers receive (≤ 120 characters after render). */
export function renderDescription(template: string, sample = SAMPLE): string {
  return template.replaceAll('{items}', sample.items).replaceAll('{order_no}', sample.order_no).trim();
}

/** Weight bounds in grams: Pathao takes 0.5–10 kg (§6.2); others 100 g – 20 kg. */
export function weightBounds(provider: CourierProvider): { min: number; max: number } {
  return provider === 'pathao' ? { min: 500, max: 10_000 } : { min: 100, max: 20_000 };
}

export interface RulesDraft {
  pickup_location_id: string;
  parcel_description: string;
  default_weight_grams: string;
  pathao_store_id: string;
  delivery_type: '48' | '12';
  redx_pickup_store_id: string;
  is_default: boolean;
}

export function rulesDraft(account: CourierAccount | undefined, fallbackPickupId: string | null): RulesDraft {
  const s: Partial<CourierSettings> = account?.settings ?? {};
  return {
    pickup_location_id: s.pickup_location_id ?? fallbackPickupId ?? '',
    parcel_description: s.parcel_description || DEFAULT_DESCRIPTION,
    default_weight_grams: String(s.default_weight_grams ?? 500),
    pathao_store_id: s.pathao_store_id ?? '',
    delivery_type: s.delivery_type === 12 ? '12' : '48',
    redx_pickup_store_id: s.redx_pickup_store_id ?? '',
    is_default: account?.is_default ?? false,
  };
}

export type RulesErrors = Partial<Record<'pickup_location_id' | 'parcel_description' | 'default_weight_grams' | 'pathao_store_id' | 'redx_pickup_store_id', string>>;

export function rulesErrors(provider: CourierProvider, d: RulesDraft): RulesErrors {
  const e: RulesErrors = {};
  if (!d.pickup_location_id) e.pickup_location_id = 'Choose where the rider collects parcels.';
  const tpl = d.parcel_description.trim();
  const unknown = tpl.match(/\{[^}]*\}/g)?.filter((v) => !(DESCRIPTION_VARIABLES as readonly string[]).includes(v));
  if (!tpl) e.parcel_description = 'Enter a description, e.g. {items} · {order_no}.';
  else if (unknown?.length) e.parcel_description = `Unknown variable ${unknown[0]}. Use {items} or {order_no}.`;
  else if (tpl.length > DESCRIPTION_MAX) e.parcel_description = `Keep it to ${DESCRIPTION_MAX} characters.`;
  const { min, max } = weightBounds(provider);
  const w = Number(d.default_weight_grams);
  if (!/^\d+$/.test(d.default_weight_grams.trim()) || w < min || w > max) e.default_weight_grams = `Enter a weight from ${min} g to ${max / 1000} kg.`;
  if (provider === 'pathao' && !d.pathao_store_id) e.pathao_store_id = 'Choose your Pathao store.';
  return e;
}

/** PATCH body (P5B-32): only what this provider uses; `cod_source` is fixed server-side. */
export function rulesInput(provider: CourierProvider, d: RulesDraft): Partial<CourierSettings> {
  const base: Partial<CourierSettings> = { pickup_location_id: d.pickup_location_id, parcel_description: d.parcel_description.trim(), default_weight_grams: Number(d.default_weight_grams) };
  if (provider === 'pathao') return { ...base, pathao_store_id: d.pathao_store_id || null, delivery_type: d.delivery_type === '12' ? 12 : 48 };
  if (provider === 'redx') return { ...base, redx_pickup_store_id: d.redx_pickup_store_id || null };
  return base;
}

/** Card footer: "Live mode · Synced 2 min ago · Default". */
export function courierFooter(a: CourierAccount | undefined, ago: (iso: string) => string): string {
  if (!a || !courierConnected(a)) return 'Uses your own account';
  const parts = [a.mode === 'sandbox' ? 'Sandbox' : 'Live mode', a.last_synced_at ? `Synced ${ago(a.last_synced_at)}` : 'Not synced yet'];
  if (a.is_default) parts.push('Default');
  return parts.join(' · ');
}

export function courierErrorMessage(code: string | undefined, short: string): string | null {
  switch (code) {
    case 'credentials_invalid':
      return `${short} didn’t accept these keys. Check them in the ${short} panel and try again.`;
    case 'provider_unavailable':
      return `${short} didn’t answer. Nothing was changed — try again in a minute.`;
    case 'courier_busy':
      return `${short} still has parcels on the way. Disconnect once they’re delivered, returned or cancelled.`;
    case 'revision_conflict':
      return 'Someone else changed these settings. We loaded the latest — check and save again.';
    default:
      return null;
  }
}
