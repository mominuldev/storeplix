import type { GatewayProvider, Payment, PaymentGatewayAccount, PaymentLink } from '@storeplix/types';
import { jsonResponse } from '../test/utils';

// Phase 5b-2 (payments) fixtures shaped like openapi 1.6.0 (PaymentGatewayAccount, PaymentLink, Payment 5b fields).

export function gateway(provider: GatewayProvider, a: Partial<PaymentGatewayAccount> = {}): PaymentGatewayAccount {
  return {
    provider,
    status: 'not_connected',
    mode: null,
    credentials_hint: null,
    enabled: false,
    is_default: false,
    verified_at: null,
    last_checked_at: null,
    last_error_code: null,
    connected_by: null,
    connected_at: null,
    revision: 1,
    ...a,
  };
}

export const connectedBkash = (a: Partial<PaymentGatewayAccount> = {}) =>
  gateway('bkash', { status: 'connected', mode: 'sandbox', credentials_hint: '••••3f9a', enabled: true, is_default: true, last_checked_at: '2026-11-22T08:00:00Z', connected_at: '2026-11-22T08:00:00Z', revision: 3, ...a });

export const gatewaysResponse = (list: PaymentGatewayAccount[] = [gateway('bkash'), gateway('sslcommerz')]) => jsonResponse(200, { data: list });

export function onlineCharge(p: Partial<Payment> = {}): Payment {
  return {
    id: 'PAY9',
    provider: 'bkash',
    type: 'charge',
    status: 'succeeded',
    amount: 7_000,
    currency: 'BDT',
    method: null,
    reference: null,
    note: null,
    actor: null,
    created_at: '2026-11-22T08:10:00Z',
    purpose: 'link',
    provider_trx_id: 'BKX7Q2M9',
    refunded_amount: 0,
    expires_at: null,
    failure_code: null,
    payment_link_id: 'L1',
    return_request_id: null,
    can_refund: true,
    ...p,
  };
}

export function paymentLink(l: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: 'L1',
    order_id: 'O1',
    amount_kind: 'delivery_charge',
    percent_bps: null,
    amount: 7_000,
    currency: 'BDT',
    provider: 'bkash',
    status: 'active',
    url: 'https://mugdho.storeplix.com/pay/AbC123xYz789',
    expires_at: new Date(Date.now() + 100 * 60_000).toISOString(),
    cancel_if_unpaid: true,
    sent_via: ['sms'],
    paid_at: null,
    created_by: { id: 'U1', name: 'Rahim Ahmed' },
    created_at: new Date().toISOString(),
    ...l,
  };
}
