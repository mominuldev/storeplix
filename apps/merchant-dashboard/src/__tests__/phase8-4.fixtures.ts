import type { ApiKey, ApiScopeInfo, WebhookDelivery, WebhookDeliveryDetail, WebhookEndpoint, WebhookEventTypeInfo, WebhookSecret } from '@storeplix/types';
import { WEBHOOK_EVENT_TYPES } from '@storeplix/types';
import { jsonResponse } from '../test/utils';
import { features } from './phase7.fixtures';

// PHASE-8-4 §6.2 shapes, Figma 144:40726 sample data.

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

export function apiKey(o: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'K1',
    name: 'Tally accounting sync',
    prefix: 'sp_live_ab12',
    last_four: '7f2a',
    masked: 'sp_live_••••7f2a',
    scopes: ['orders:read', 'products:read'],
    include_costs: false,
    status: 'active',
    created_at: '2026-10-02T09:00:00Z',
    created_by: { id: 'U1', name: 'Rafiqul Alam' },
    last_used_at: ago(2 * MIN),
    revoked_at: null,
    ...o,
  };
}

export const keys: ApiKey[] = [
  apiKey(),
  apiKey({ id: 'K2', name: 'Warehouse picker app', masked: 'sp_live_••••c19e', last_four: 'c19e', scopes: ['orders:read', 'orders:write', 'inventory:read'], last_used_at: ago(HOUR) }),
  apiKey({ id: 'K3', name: 'Old POS test', masked: 'sp_live_••••88a1', last_four: '88a1', status: 'revoked', revoked_at: '2026-11-12T09:00:00Z', last_used_at: null }),
];

const scope = (key: ApiScopeInfo['key'], label: string, group: ApiScopeInfo['group'], backing: ApiScopeInfo['backing_permission'], implies: ApiScopeInfo['implies'] = [], grantable = true): ApiScopeInfo => ({
  key,
  label,
  group,
  backing_permission: backing,
  implies,
  grantable,
});

export function scopes(nonGrantable: ApiScopeInfo['key'][] = []): ApiScopeInfo[] {
  return [
    scope('orders:read', 'Orders · read', 'orders', 'orders.view'),
    scope('orders:write', 'Orders · write', 'orders', 'orders.process', ['orders:read']),
    scope('products:read', 'Products', 'products', null),
    scope('products:write', 'Products · write', 'products', 'products.edit', ['products:read']),
    scope('inventory:read', 'Stock', 'inventory', null),
    scope('inventory:write', 'Stock · write', 'inventory', 'inventory.adjust', ['inventory:read']),
    scope('customers:read', 'Customers · read', 'customers', 'customers.view'),
  ].map((s) => ({ ...s, grantable: !nonGrantable.includes(s.key) }));
}

export function endpoint(o: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: 'E1',
    url: 'https://tally.mugdho.com/hooks/storeplix',
    description: null,
    events: ['order.created', 'order.paid', 'order.cancelled', 'customer.created'],
    is_active: true,
    disabled_reason: null,
    failing_since: null,
    last_delivery_at: ago(2 * MIN),
    last_status: 200,
    success_rate_7d: 99.8,
    created_at: '2026-10-02T09:00:00Z',
    updated_at: '2026-10-02T09:00:00Z',
    ...o,
  };
}

export const endpoints: WebhookEndpoint[] = [
  endpoint(),
  endpoint({ id: 'E3', url: 'https://picker.mugdho.app/api/ship', events: ['shipment.updated', 'shipment.delivered'], failing_since: '2026-11-24T09:40:00+06:00', last_status: 503, success_rate_7d: 62 }),
];

export const eventTypes: WebhookEventTypeInfo[] = WEBHOOK_EVENT_TYPES.map((key) => ({ key, label: key, description: `${key} happened` }));

export const secret: WebhookSecret = { last_four: '3kQ9', masked: 'whsec_••••3kQ9', rotated_at: null, previous_expires_at: null };

export function delivery(o: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'D1',
    endpoint_id: 'E1',
    event_id: '01JDELIVERYEVENT0000000001',
    event_type: 'order.created',
    subject_label: 'GS-1048',
    status: 'succeeded',
    attempts: 1,
    next_attempt_at: null,
    last_attempt_at: ago(5 * MIN),
    response_status: 200,
    error_code: null,
    duration_ms: 182,
    created_at: ago(5 * MIN),
    ...o,
  };
}

export const deliveries: WebhookDelivery[] = [
  delivery(),
  delivery({ id: 'D2', endpoint_id: 'E3', event_type: 'shipment.updated', subject_label: 'GS-1045', status: 'failed', response_status: 503, attempts: 7, created_at: ago(30 * MIN) }),
  delivery({ id: 'D3', event_type: 'order.paid', subject_label: 'GS-1031', created_at: ago(40 * MIN) }),
];

export function deliveryDetail(o: Partial<WebhookDeliveryDetail> = {}): WebhookDeliveryDetail {
  return {
    ...delivery(),
    payload: { id: '01JDELIVERYEVENT0000000001', type: 'order.created', api_version: '2026-12-01', created_at: ago(5 * MIN), store_id: 'S1', data: { object: { id: 'O1', number: 'GS-1048' } } },
    request_headers: { 'Content-Type': 'application/json', 'X-Storeplix-Event': 'order.created', 'X-Storeplix-Signature': '[redacted]' },
    response_body_excerpt: 'ok',
    ...o,
  };
}

export const growth = (o: Parameters<typeof features>[0] = {}) => features({ plan_code: 'growth', ...o, features: { ...features().features, api_webhooks: true, ...o.features } });

/** All §6.1 reads for the Developer page. */
export function developerRoutes(o: { features?: ReturnType<typeof features>; keys?: ApiKey[]; endpoints?: WebhookEndpoint[]; deliveries?: WebhookDelivery[]; scopes?: ApiScopeInfo[] } = {}) {
  const list = o.deliveries ?? deliveries;
  return {
    'GET /features': jsonResponse(200, { data: o.features ?? growth() }),
    'GET /api-keys': jsonResponse(200, { data: o.keys ?? keys }),
    'GET /api-scopes': jsonResponse(200, { data: o.scopes ?? scopes() }),
    'GET /webhook-event-types': jsonResponse(200, { data: eventTypes }),
    'GET /stores/S1/webhook-endpoints': jsonResponse(200, { data: o.endpoints ?? endpoints }),
    'GET /stores/S1/webhook-secret': jsonResponse(200, { data: secret }),
    'GET /stores/S1/webhook-deliveries': jsonResponse(200, { data: list, meta: { next_cursor: null, prev_cursor: null, per_page: 25 } }),
  };
}
