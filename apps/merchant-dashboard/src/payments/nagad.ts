import { isApiError, isImpersonationReadOnly } from '@storeplix/api-client';
import type { GatewayCapability, NagadCredentialsInput, PaymentGatewayAccount } from '@storeplix/types';
import { errorMessage } from '../catalog/states';
import { READ_ONLY_MESSAGE } from '../impersonation/ApiErrorWatcher';

// PHASE-8-9D §9 (WEB) pure helpers for the Nagad page (Figma 2134:67228): client-side checks before PUT (the API
// re-validates and parses the keys with OpenSSL, §9.2), capabilities (P89D-45) and error copy.

/** Capabilities when the API predates 8.9d's `capabilities` field (P89D-45 default for Nagad). */
export const NAGAD_DEFAULT_CAPABILITIES: GatewayCapability[] = ['query', 'webhook'];
export const capabilitiesOf = (a: Pick<PaymentGatewayAccount, 'capabilities'> | undefined): GatewayCapability[] => a?.capabilities ?? NAGAD_DEFAULT_CAPABILITIES;

export type NagadField = keyof NagadCredentialsInput;

const PRIVATE_PEM = /^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----$/;
const PUBLIC_PEM = /^-----BEGIN (RSA )?PUBLIC KEY-----[\s\S]+-----END (RSA )?PUBLIC KEY-----$/;
/** Nagad's portal often shows the key body only (base64, no BEGIN/END lines); a 2048-bit key is ≥ 300 chars. */
const BARE_KEY = /^[A-Za-z0-9+/=\s]{300,}$/;

/** BD mobile: 01XXXXXXXXX (with or without +88). */
export const BD_MOBILE = /^(?:\+?88)?01[3-9]\d{8}$/;

export function nagadFieldProblem(field: NagadField, raw: string): string | null {
  const v = raw.trim();
  switch (field) {
    case 'merchant_id':
      if (!v) return 'Enter your Merchant ID.';
      return /^[A-Za-z0-9]{6,64}$/.test(v) ? null : 'Merchant IDs are letters and numbers only, e.g. 683002007104225.';
    case 'merchant_number':
      if (!v) return 'Enter your Nagad merchant number.';
      return BD_MOBILE.test(v.replace(/[\s-]/g, '')) ? null : 'Use the 11-digit Nagad number, e.g. 01700000000.';
    case 'merchant_private_key':
      if (!v) return 'Paste your merchant private key.';
      if (PUBLIC_PEM.test(v)) return 'This is a public key. Paste the merchant private key here.';
      return PRIVATE_PEM.test(v) || BARE_KEY.test(v) ? null : 'That doesn’t look like a private key. Paste the whole key from the Nagad portal.';
    case 'pg_public_key':
      if (!v) return 'Paste the Nagad payment gateway public key.';
      if (PRIVATE_PEM.test(v)) return 'This is a private key. Paste Nagad’s public key here.';
      return PUBLIC_PEM.test(v) || BARE_KEY.test(v) ? null : 'That doesn’t look like a public key. Paste the whole key from the Nagad portal.';
  }
}

export const NAGAD_FIELDS: NagadField[] = ['merchant_id', 'merchant_number', 'merchant_private_key', 'pg_public_key'];

export function nagadProblems(values: Partial<Record<NagadField, string>>): Partial<Record<NagadField, string>> {
  const out: Partial<Record<NagadField, string>> = {};
  for (const f of NAGAD_FIELDS) {
    const p = nagadFieldProblem(f, values[f] ?? '');
    if (p) out[f] = p;
  }
  return out;
}

/** What we send: trimmed values, merchant number as 01XXXXXXXXX. Keys keep their line breaks. */
export function nagadInput(values: Record<NagadField, string>): NagadCredentialsInput {
  const digits = values.merchant_number.replace(/[\s-]/g, '').replace(/^\+?88/, '');
  return { merchant_id: values.merchant_id.trim(), merchant_number: digits, merchant_private_key: values.merchant_private_key.trim(), pg_public_key: values.pg_public_key.trim() };
}

export function nagadErrorText(error: unknown, fallback = 'We couldn’t save these keys.'): string {
  if (isImpersonationReadOnly(error)) return READ_ONLY_MESSAGE;
  if (!isApiError(error)) return errorMessage(error, fallback);
  switch (error.code) {
    case 'credentials_invalid':
    case 'integration_credentials_invalid':
      return 'Nagad didn’t accept these keys. Check the Merchant ID and both keys in the Nagad portal, then try again.';
    case 'provider_unavailable':
      return 'Nagad didn’t answer. Nothing was saved — try again in a minute.';
    case 'gateway_busy':
      return 'Nagad still has payments or refunds in progress. Try again once they finish.';
    case 'gateway_not_connected':
      return 'Nagad isn’t ready for checkout yet. Save working keys first (live mode needs a passed test).';
    case 'revision_conflict':
      return 'Someone else changed Nagad. We loaded the latest — check and try again.';
    case 'gateway_refund_unsupported':
      return 'Refund in the Nagad merchant portal, then record a manual refund.';
    default:
      return error.status === 403 ? 'Only owners and managers can change payment accounts.' : error.message || fallback;
  }
}

/** "••••4225" — the API hint is the merchant ID's last 4 (§9.2). */
export const merchantIdMask = (hint: string | null | undefined) => (hint ? (hint.startsWith('•') ? hint : `••••${hint.slice(-4)}`) : null);
