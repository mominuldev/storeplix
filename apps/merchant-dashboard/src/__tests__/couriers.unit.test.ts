import { describe, expect, it } from 'vitest';
import { courierFooter, courierMeta, renderDescription, rulesDraft, rulesErrors, rulesInput } from '../couriers/couriers';
import { connectedSteadfast, courier } from './couriers.fixtures';

// Phase 5b-3 courier helpers (P5B-32 booking rules, §4.6 credentials per provider).

describe('courier helpers', () => {
  it('credential fields per provider match ConnectCourierInput', () => {
    expect(courierMeta.steadfast.fields.map((f) => f.key)).toEqual(['api_key', 'secret_key']);
    expect(courierMeta.pathao.fields.map((f) => f.key)).toEqual(['client_id', 'client_secret', 'username', 'password']);
    expect(courierMeta.redx.fields.map((f) => f.key)).toEqual(['access_token']);
    expect(courierMeta.redx.webhookHint).toBeNull();
  });

  it('renders the description template with both variables', () => {
    expect(renderDescription('{items} · {order_no}', { items: 'Saree ×2', order_no: 'GS-1' })).toBe('Saree ×2 · GS-1');
    expect(renderDescription('Order {order_no}', { items: 'x', order_no: 'GS-9' })).toBe('Order GS-9');
  });

  it('validates rules: pickup, unknown variable, length, weight bounds per provider, Pathao store', () => {
    const d = rulesDraft(courier('pathao'), null);
    expect(d.parcel_description).toBe('{items} · {order_no}');
    const e = rulesErrors('pathao', { ...d, default_weight_grams: '300', parcel_description: 'x'.repeat(121) });
    expect(Object.keys(e).sort()).toEqual(['default_weight_grams', 'parcel_description', 'pathao_store_id', 'pickup_location_id']);
    expect(rulesErrors('steadfast', { ...d, pickup_location_id: 'PL1', default_weight_grams: '300' })).toEqual({});
    expect(rulesErrors('steadfast', { ...d, pickup_location_id: 'PL1', parcel_description: '{sku}' }).parcel_description).toMatch(/Unknown variable \{sku\}/);
    expect(rulesErrors('redx', { ...d, pickup_location_id: 'PL1', default_weight_grams: '1.5' }).default_weight_grams).toBeDefined();
  });

  it('builds a provider-specific PATCH body', () => {
    const d = { ...rulesDraft(connectedSteadfast(), null), pathao_store_id: '7', redx_pickup_store_id: '9' };
    expect(rulesInput('steadfast', d)).toEqual({ pickup_location_id: 'PL1', parcel_description: '{items} · {order_no}', default_weight_grams: 500 });
    expect(rulesInput('pathao', d)).toMatchObject({ pathao_store_id: '7', delivery_type: 48 });
    expect(rulesInput('redx', d)).toMatchObject({ redx_pickup_store_id: '9' });
    expect(rulesInput('redx', { ...d, redx_pickup_store_id: '' }).redx_pickup_store_id).toBeNull();
  });

  it('card footer', () => {
    expect(courierFooter(courier('redx'), () => '')).toBe('Uses your own account');
    expect(courierFooter(connectedSteadfast({ mode: 'sandbox', is_default: false, last_synced_at: null }), () => '')).toBe('Sandbox · Not synced yet');
  });
});
