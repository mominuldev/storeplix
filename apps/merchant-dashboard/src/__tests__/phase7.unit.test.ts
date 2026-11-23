import { describe, expect, it } from 'vitest';
import { billingBannerKind } from '../plan/Banners';
import { isSafeRedirect, limitWarning, limitWarningText, nextPlan, planAction } from '../plan/billing';
import { heatTone } from '../reports/DeliveryTab';
import { waterfallBars } from '../reports/ProfitTab';
import { addDays, dayLabel, localToday, presetRange, rangeError, rangeFromParams, rangeLabel, weekLabel } from '../reports/range';
import { compactBdt, delta } from '../reports/ui';
import { invoiceStatus } from '../settings/billing/InvoicesCard';
import { quoteSummary, warningFits } from '../settings/billing/ChangePlanDialog';
import { features, inDays, invoiceSummary, planBy, plans, profitReport, quote, subscription } from './phase7.fixtures';

describe('planAction (§3.3 labels)', () => {
  const free = subscription();
  const trial = subscription({ status: 'trialing', plan: planBy('starter'), trial_ends_at: inDays(5) });
  const starterMonth = subscription({ plan: planBy('starter') });
  const starterYear = subscription({ plan: planBy('starter'), billing_interval: 'year' });
  const growth = subscription({ plan: planBy('growth') });
  it.each([
    [free, 'free', 'month', 'current'],
    [free, 'starter', 'month', 'subscribe'],
    [free, 'growth', 'year', 'subscribe'],
    [trial, 'starter', 'month', 'subscribe'],
    [trial, 'free', 'month', 'none'],
    [starterMonth, 'starter', 'month', 'current'],
    [starterMonth, 'starter', 'year', 'upgrade'],
    [starterMonth, 'growth', 'month', 'upgrade'],
    [starterMonth, 'free', 'month', 'switch'],
    [starterYear, 'starter', 'month', 'switch'],
    [growth, 'starter', 'month', 'switch'],
  ] as const)('%#: %s → %s %s = %s', (sub, code, interval, expected) => {
    expect(planAction(sub, plans, planBy(code), interval)).toBe(expected);
  });
  it('marks the scheduled target', () => {
    const s = subscription({ plan: planBy('growth'), scheduled_change: { plan: planBy('starter'), interval: 'month', effective_at: inDays(5) } });
    expect(planAction(s, plans, planBy('starter'), 'month')).toBe('scheduled');
    expect(planAction(s, plans, planBy('starter'), 'year')).toBe('switch');
  });
  it('nextPlan is the cheapest paid plan above', () => {
    expect(nextPlan(plans, 'free')?.code).toBe('starter');
    expect(nextPlan(plans, 'starter')?.code).toBe('growth');
    expect(nextPlan(plans, 'growth')).toBeNull();
  });
});

describe('limit warning (65:17445)', () => {
  it('projects the orders limit date from local days elapsed', () => {
    const w = limitWarning(features({}, { orders_per_month: { limit: 50, used: 40 } }), new Date(2026, 10, 19));
    expect(w?.key).toBe('orders_per_month');
    expect(w?.reachOn).toBe('24 Nov');
    expect(limitWarningText(w!)).toBe('40 of 50 orders used — at this pace you’ll reach the limit around 24 Nov.');
  });
  it('omits the projection before day 3 and ignores limits under 80 %', () => {
    expect(limitWarning(features({}, { orders_per_month: { limit: 50, used: 45 } }), new Date(2026, 10, 2))?.reachOn).toBeNull();
    expect(limitWarning(features(), new Date(2026, 10, 19))).toBeNull();
    expect(limitWarning(features({}, { products: { limit: 100, used: 90 } }), new Date(2026, 10, 19))?.key).toBe('products');
    expect(limitWarning(features({}, { orders_per_month: { limit: null, used: 900 } }))).toBeNull();
  });
});

describe('billing helpers', () => {
  it('only lets https (or local dev) provider pages receive the browser', () => {
    expect(isSafeRedirect('https://sandbox.bka.sh/x')).toBe(true);
    expect(isSafeRedirect('http://localhost:8000/api/v1/dev/fake-billing-gateway/P1')).toBe(true);
    expect(isSafeRedirect('http://evil.test/x')).toBe(false);
    expect(isSafeRedirect('javascript:alert(1)')).toBe(false);
    expect(isSafeRedirect(null)).toBe(false);
  });
  it('maps invoice statuses', () => {
    expect(invoiceStatus(invoiceSummary({ status: 'paid' }))).toEqual({ label: 'Paid', tone: 'success' });
    expect(invoiceStatus(invoiceSummary({ status: 'open' }))).toEqual({ label: 'Open', tone: 'info' });
    expect(invoiceStatus(invoiceSummary({ status: 'open', is_overdue: true }))).toEqual({ label: 'Overdue', tone: 'danger' });
    expect(invoiceStatus(invoiceSummary({ status: 'void' }))).toEqual({ label: 'Void', tone: 'neutral' });
  });
  it('quote copy per kind', () => {
    expect(quoteSummary(quote())).toBe('Charged ৳ 400 now for the rest of this month, then ৳ 1,499 on 1 Dec 2026.');
    expect(quoteSummary(quote({ kind: 'upgrade', interval: 'year', amount: 480000, credit_amount: 19000, period_end: '2027-11-23T00:00:00Z' }))).toBe(
      'Charged ৳ 4,800 now (৳ 190 credit for the unused time included), then ৳ 14,990 on 23 Nov 2027.',
    );
    expect(quoteSummary(quote({ kind: 'new', plan: planBy('starter'), amount: 49900, period_end: '2026-12-23T00:00:00Z' }))).toBe('Charged ৳ 499 now for your Starter plan until 23 Dec 2026, then ৳ 499 on 23 Dec 2026.');
    expect(quoteSummary(quote({ kind: 'downgrade', plan: planBy('starter'), amount: 0, requires_payment: false, effective_at: '2026-12-01T00:00:00Z' }))).toBe(
      'Switches to Starter (monthly) on 1 Dec 2026, no charge. You keep your current plan until then.',
    );
    expect(quoteSummary(quote({ kind: 'cancel', plan: planBy('free'), amount: 0, requires_payment: false, effective_at: inDays(-0.001) }))).toMatch(/moves to the Free plan now/);
  });
  it('quote warnings: feature losses never fit; limits fit when there is room', () => {
    expect(warningFits({ key: 'profit_reports', used: null, limit: null, message: 'Profit & loss reports is not included in Starter.' })).toBe(false);
    expect(warningFits({ key: 'products', used: 140, limit: 1000, message: 'x' })).toBe(true);
    expect(warningFits({ key: 'products', used: 140, limit: null, message: 'x' })).toBe(true);
    expect(warningFits({ key: 'custom_domains', used: 3, limit: 2, message: 'x' })).toBe(false);
  });
  it('banner priority past_due > domain > renewal > trial', () => {
    const renewal = invoiceSummary({ kind: 'renewal', due_at: inDays(3) });
    expect(billingBannerKind(subscription({ status: 'past_due', domain_grace_ends_at: inDays(2), open_invoice: renewal }), undefined)).toBe('past_due');
    expect(billingBannerKind(subscription({ domain_grace_ends_at: inDays(2), open_invoice: renewal }), undefined)).toBe('domain');
    expect(billingBannerKind(subscription({ open_invoice: renewal }), undefined)).toBe('renewal');
    expect(billingBannerKind(subscription({ open_invoice: invoiceSummary({ kind: 'renewal', due_at: inDays(9) }) }), undefined)).toBeNull();
    expect(billingBannerKind(subscription({ status: 'trialing' }), undefined)).toBe('trial');
    expect(billingBannerKind(undefined, features({ subscription_status: 'trialing' }))).toBe('trial');
    expect(billingBannerKind(subscription(), undefined)).toBeNull();
  });
});

describe('report range ↔ URL', () => {
  const today = '2026-11-23';
  it('presets', () => {
    expect(presetRange('this_month', today)).toEqual({ from: '2026-11-01', to: today, preset: 'this_month' });
    expect(presetRange('last_month', today)).toEqual({ from: '2026-10-01', to: '2026-10-31', preset: 'last_month' });
    expect(presetRange('last_30', today).from).toBe('2026-10-25');
    expect(presetRange('last_90', today).from).toBe('2026-08-26');
    expect(presetRange('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31', preset: 'last_month' });
  });
  it('reads the URL, matching presets and clipping to today', () => {
    expect(rangeFromParams(new URLSearchParams(), today).preset).toBe('this_month');
    expect(rangeFromParams(new URLSearchParams('from=2026-10-01&to=2026-10-31'), today).preset).toBe('last_month');
    expect(rangeFromParams(new URLSearchParams('from=2026-11-02&to=2026-11-10'), today)).toEqual({ from: '2026-11-02', to: '2026-11-10', preset: 'custom' });
    expect(rangeFromParams(new URLSearchParams('from=2026-11-10&to=2026-11-02'), today).preset).toBe('this_month');
    expect(rangeFromParams(new URLSearchParams('from=2024-01-01&to=2026-11-01'), today).preset).toBe('this_month');
    expect(rangeFromParams(new URLSearchParams('from=bad&to=2026-11-01'), today).preset).toBe('this_month');
  });
  it('validates custom ranges', () => {
    expect(rangeError('2026-11-01', '2026-11-05', today)).toBeNull();
    expect(rangeError('2026-11-05', '2026-11-01', today)).toMatch(/before/);
    expect(rangeError('2025-01-01', '2026-11-01', today)).toBe('Pick at most 366 days.');
    expect(rangeError('2019-12-01', '2019-12-02', today)).toMatch(/2020/);
    expect(rangeError('', '2026-11-01', today)).toBe('Pick both dates.');
  });
  it('labels', () => {
    expect(rangeLabel('2026-11-01', '2026-11-30')).toBe('1 – 30 Nov 2026');
    expect(rangeLabel('2026-10-28', '2026-11-23')).toBe('28 Oct – 23 Nov 2026');
    expect(rangeLabel('2025-12-01', '2026-01-03')).toBe('1 Dec 2025 – 3 Jan 2026');
    expect(dayLabel('2026-11-14')).toBe('Sat 14 Nov');
    expect(weekLabel('2026-W36')).toBe('W36');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(localToday('Asia/Dhaka', new Date('2026-11-30T19:00:00Z'))).toBe('2026-12-01');
    expect(localToday('Not/AZone', new Date('2026-11-30T10:00:00Z'))).toMatch(/^2026-11-30$/);
  });
});

describe('report formatting', () => {
  it('delta', () => {
    expect(delta(114, 100, 'ratio')).toEqual({ label: '↑ 14%', good: true });
    expect(delta(98, 100, 'ratio', false)).toEqual({ label: '↓ 2%', good: true });
    expect(delta(0.211, 0.223, 'points')).toEqual({ label: '↓ 1.2 pts', good: false });
    expect(delta(2.1, 2.4, 'days', false)).toEqual({ label: '↓ 0.3 d', good: true });
    expect(delta(31, 27, 'count', false)).toEqual({ label: '↑ 4', good: false });
    expect(delta(5, 0, 'ratio')).toBeNull();
    expect(delta(5, null, 'ratio')).toBeNull();
  });
  it('compactBdt axis ticks', () => {
    expect(compactBdt(4000000)).toBe('৳ 40k');
    expect(compactBdt(50000000)).toBe('৳ 5L');
    expect(compactBdt(15000000)).toBe('৳ 1.5L');
    expect(compactBdt(0)).toBe('৳ 0');
  });
  it('waterfall steps down from revenue and labels untracked costs', () => {
    const bars = waterfallBars(profitReport().summary);
    expect(bars.map((b) => b.label)).toEqual(['Revenue', 'Product cost', 'Delivery charges', 'Courier COD fee', 'Gateway fees', 'Ad spend', 'Net profit']);
    expect(bars[1]).toMatchObject({ value: 24830000, base: 48620000 - 24830000 });
    expect(bars[2]).toMatchObject({ base: 48620000 - 24830000 - 5230000 });
    expect(bars[4]).toMatchObject({ value: null, note: 'Not tracked' });
    expect(bars[6]).toMatchObject({ value: 17374000, tone: 'success' });
  });
  it('heat tiles', () => {
    expect(heatTone(0.94)).toContain('success');
    expect(heatTone(0.85)).toContain('warning');
    expect(heatTone(0.7)).toContain('danger');
    expect(heatTone(null)).toContain('surface-subtle');
  });
});
