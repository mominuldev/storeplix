import { formatBdt } from '@storeplix/ui';
import { describe, expect, it } from 'vitest';
import { advanceAmount, advanceError, linkGateways, onlineRefundable, paymentLinkSms, timeLeft } from '../payments/gateways';
import { connectedBkash, gateway, onlineCharge } from './phase5b2.fixtures';

const order = { due_amount: 313_000, shipping_amount: 13_000 };

describe('ask for an advance amounts (P5B-22, 144:46081)', () => {
  it('delivery charge = shipping amount, capped at what is due', () => {
    expect(advanceAmount('delivery_charge', order, null, null)).toBe(13_000);
    expect(advanceAmount('delivery_charge', { due_amount: 5_000, shipping_amount: 13_000 }, null, null)).toBe(5_000);
    expect(advanceAmount('delivery_charge', { due_amount: 5_000, shipping_amount: 0 }, null, null)).toBeNull();
    expect(advanceError('delivery_charge', { due_amount: 5_000, shipping_amount: 0 }, null, null, formatBdt)).toBe('This order has no delivery charge.');
  });

  it('25 % of the due amount by default, editable, rounded to the paisa', () => {
    expect(advanceAmount('percent', order, 2_500, null)).toBe(78_250);
    expect(advanceAmount('percent', { due_amount: 177_000, shipping_amount: 7_000 }, 2_500, null)).toBe(44_250);
    expect(advanceAmount('percent', order, 3_333, null)).toBe(104_323);
    expect(advanceError('percent', order, 50, null, formatBdt)).toMatch(/between 1 and 99/);
    expect(advanceError('percent', order, 10_000, null, formatBdt)).toMatch(/between 1 and 99/);
    expect(advanceError('percent', order, 2_500, null, formatBdt)).toBeNull();
  });

  it('full = due; custom between ৳ 1 and the due amount', () => {
    expect(advanceAmount('full', order, null, null)).toBe(313_000);
    expect(advanceError('custom', order, null, null, formatBdt)).toBe('Enter an amount.');
    expect(advanceError('custom', order, null, 99, formatBdt)).toBe('Ask for at least ৳ 1.');
    expect(advanceError('custom', order, null, 313_001, formatBdt)).toBe('Up to ৳ 3,130 — what’s still due.');
    expect(advanceError('custom', order, null, 100, formatBdt)).toBeNull();
    expect(advanceError('custom', order, null, 313_000, formatBdt)).toBeNull();
  });

  it('SMS preview follows the P5B-28 templates', () => {
    expect(paymentLinkSms('en', 'Mugdho Fashion', 'GS-1041', 13_000, 'https://x/pay/abc')).toBe('Mugdho Fashion: Pay Tk 130 to confirm order GS-1041: https://x/pay/abc');
    expect(paymentLinkSms('bn', 'Mugdho Fashion', 'GS-1041', 78_250, 'u')).toBe('Mugdho Fashion: অর্ডার GS-1041 নিশ্চিত করতে 782.5 টাকা পরিশোধ করুন: u');
  });
});

describe('gateway helpers', () => {
  it('link gateways are connected + enabled, default first', () => {
    const ssl = gateway('sslcommerz', { status: 'connected', enabled: true });
    expect(linkGateways([ssl, connectedBkash()]).map((g) => g.provider)).toEqual(['bkash', 'sslcommerz']);
    expect(linkGateways([connectedBkash({ enabled: false }), gateway('sslcommerz')])).toEqual([]);
  });

  it('online refundable sums succeeded gateway charges minus their refunds, ignoring tests', () => {
    expect(onlineRefundable([onlineCharge({ amount: 10_000, refunded_amount: 2_500 }), onlineCharge({ id: 'T', purpose: 'test', amount: 1_000 }), onlineCharge({ id: 'F', status: 'failed' })])).toEqual({ amount: 7_500, provider: 'bkash' });
    expect(onlineRefundable([])).toEqual({ amount: 0, provider: null });
  });

  it('time left reads like the Figma banner', () => {
    const now = Date.parse('2026-11-22T10:00:00Z');
    expect(timeLeft('2026-11-22T11:40:00Z', now)).toBe('1 h 40 min left');
    expect(timeLeft('2026-11-22T10:20:00Z', now)).toBe('20 min left');
    expect(timeLeft('2026-11-22T09:00:00Z', now)).toBe('expired');
  });
});
