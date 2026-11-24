import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { eventText, heroLine, reasonsSentence, reasonText, ruleOptions, RULES, rulesOn, stoppedSplit, blockReason, blockedBy, orderTier, guardLocked } from '../fraud/fraud';
import { fraudKeys, invalidateAfterBlock } from '../fraud/queries';
import { visibleNav } from '../layout/nav';
import { can } from '../lib/permissions';
import { eventToEntry } from '../orders/timeline';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { customer } from './catalog.fixtures';
import { geo, order, orderCounts, orderList, orderSummary } from './phase5.fixtures';
import { connectedBkash, gatewaysResponse, paymentLink } from './phase5b2.fixtures';
import { features } from './phase7.fixtures';
import { blocked, blockedRows, events, guard, guardEvent, guardRoutes, guardSettings, numberCheck, overview, starter } from './phase8-8.fixtures';

// PHASE-8-8 §13 Web: guard page from fixtures (VPN + courier rules absent, "Advance collected" tile, 6 rules, autosave,
// reset), dialogs, blocked list + full page, decision log + full page, order list column / filter / "On hold" chip,
// order detail banners (advance, call_first, checking), Delivery record card (no Steadfast/Pathao/RedX bars), customer
// Risk + block card, nav item by permission, plan note, query invalidation `[tenantId, storeId, 'orders']` after release.

const SLOW = { timeout: 5000 };
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const geoRoute = { 'GET /geo/bd': jsonResponse(200, { data: geo }) };

describe('PHASE-8-8 helpers', () => {
  it('reason copy, record line and rule maths', () => {
    expect(reasonText('rate_below_hold', { rate: 58, record: { total: 12, delivered: 7, sources: [] } })).toBe('only 58% delivered (7 of 12) — below your hold line');
    expect(reasonText('duplicate')).toBe('same phone ordered the same product recently');
    expect(reasonsSentence(guard({ reasons: ['new_number', 'otp_unavailable'] }))).toBe('First order from this number · the SMS code couldn’t be sent');
    expect(reasonsSentence(null)).toBe('');
    expect(RULES.map((r) => r.title)).toEqual([
      'Hold risky orders for a call',
      'Ask for delivery charge in advance',
      'Verify new numbers with OTP',
      'Block repeat returners',
      'Catch duplicate orders',
      'Limit orders per phone',
    ]);
    expect(rulesOn(guardSettings())).toBe(5);
    expect(rulesOn(guardSettings({ enabled: false }))).toBe(0);
    expect(heroLine(5)).toBe('5 of 6 rules on · checking your own orders');
    // advance_below ≥ hold_below (§8.3) both ways
    const s = guardSettings({ hold_below: 60, advance_below: 75 });
    expect(Math.max(...ruleOptions('hold_below', s))).toBe(75);
    expect(Math.min(...ruleOptions('advance_below', s))).toBe(60);
    expect(ruleOptions('duplicate_window_hours', s)).toEqual([6, 12, 24, 48, 72]);
    expect(ruleOptions('daily_limit', guardSettings({ daily_limit: 25 }))).toContain(25);
    expect(stoppedSplit(overview())).toEqual({ total: 63, text: '41 held · 14 blocked · 8 duplicates' });
    expect(stoppedSplit(overview({ stopped: { held: 1, blocked: 0, duplicates: 1, limited: 2 } })).text).toBe('1 held · 0 blocked · 1 duplicate · 2 over the limit');
  });

  it('blocked rows, decision text, tier of an order, plan lock', () => {
    expect(blockReason(blocked())).toEqual({ title: '5 returns at your shop', detail: null });
    expect(blockReason(blockedRows[1]!)).toEqual({ title: 'Refused 3 parcels at the door', detail: '3 returns at your shop' });
    expect(blockedBy(blocked())).toEqual({ who: 'Auto', role: 'Return rule' });
    expect(blockedBy(blockedRows[1]!)).toEqual({ who: 'Sumi', role: 'Manager' });
    expect(eventText(events[0]!)).toEqual({ title: 'GS-1041', detail: 'Only 58% delivered (7 of 12) — below your hold line' });
    expect(eventText(events[1]!).detail).toBe('৳ 130 payment link sent by SMS · 71% delivered');
    expect(eventText(events[3]!)).toEqual({ title: '01521•••877', detail: '6th order today · limit is 3 per phone' });
    expect(eventText(events[4]!).title).toBe('GS-1037 → kept GS-1035');
    expect(eventText(guardEvent({ type: 'auto_blocked', detail: {} })).detail).toBe('Blocked by the return rule');
    expect(orderTier(orderSummary({ guard: guard({ tier: 'careful' }) }))).toBe('careful');
    expect(orderTier(orderSummary({ guard: null }))).toBe('good');
    expect(guardLocked(features())).toBe(true);
    expect(guardLocked(starter())).toBe(false);
    expect(guardLocked(undefined)).toBe(false);
  });

  it('timeline renders guard events (own shop only)', () => {
    const entry = eventToEntry({ id: 'E9', type: 'guard', from_status: null, to_status: null, actor: { type: 'system', user: null }, body: null, meta: { tier: 'risky', rate: 58, decision: 'hold', hold: 'call_first', reasons: ['rate_below_hold'] }, created_at: new Date().toISOString() });
    expect(entry.title).toBe('Fraud check: Risky (58% delivered)');
    expect(entry.detail).toContain('Your shop’s orders');
    expect(entry.detail).toContain('held for a call');
    expect(String(entry.detail)).not.toMatch(/Steadfast|Pathao|RedX/);
    expect(entry.tone).toBe('danger');
  });

  it('block writes refresh the guard, customers and orders keys', async () => {
    const qc = new QueryClient();
    const s = { tenantId: 'T1', storeId: 'S1' };
    qc.setQueryData(fraudKeys.settings(s), 1);
    qc.setQueryData(['T1', 'S1', 'customers', {}], 1);
    qc.setQueryData(['T1', 'S1', 'orders', {}], 1);
    qc.setQueryData(['T1', 'S1', 'products'], 1);
    await invalidateAfterBlock(qc, s);
    expect(qc.getQueryState(fraudKeys.settings(s))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['T1', 'S1', 'customers', {}])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['T1', 'S1', 'orders', {}])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['T1', 'S1', 'products'])?.isInvalidated).toBe(false);
  });

  it('permission and nav: Fake order guard only with fraud.manage', () => {
    const guardNav = (m: Parameters<typeof visibleNav>[0]) => visibleNav(m).find((n) => n.to === '/orders')?.children?.some((c) => c.to === '/orders/fraud-guard') ?? false;
    expect(can.manageFraudGuard({ role: 'owner' })).toBe(true);
    expect(can.manageFraudGuard({ role: 'admin' })).toBe(true);
    expect(can.manageFraudGuard({ role: 'staff' })).toBe(false);
    expect(guardNav({ role: 'owner' })).toBe(true);
    expect(guardNav({ role: 'staff' })).toBe(false);
    expect(guardNav({ role: 'custom', permissions: ['orders.view', 'fraud.manage'] })).toBe(true);
  });
});

describe('Fake order guard page (§10.1)', () => {
  it('header, hero with Advance collected, six rules (no courier or VPN rule), blocked list and decisions', async () => {
    signedIn('owner', guardRoutes());
    renderApp(<AppRoutes />, { route: '/orders/fraud-guard' });
    expect(await screen.findByRole('heading', { level: 1, name: /Fake order guard/ }, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('Protection on', undefined, SLOW)).toBeInTheDocument();
    const hero = screen.getByRole('region', { name: 'Protection' });
    expect(within(hero).getByText('Your shop is protected')).toBeInTheDocument();
    expect(within(hero).getByText('5 of 6 rules on · checking your own orders')).toBeInTheDocument();
    expect(await within(hero).findByText('1,248')).toBeInTheDocument();
    expect(within(hero).getByText('63')).toBeInTheDocument();
    expect(within(hero).getByText('41 held · 14 blocked · 8 duplicates')).toBeInTheDocument();
    expect(within(hero).getByText('Advance collected')).toBeInTheDocument();
    expect(within(hero).getByText('৳ 7,560')).toBeInTheDocument();
    expect(within(hero).queryByText('Delivery charges saved')).toBeNull();

    const rules = screen.getByRole('region', { name: 'Rules' });
    expect(within(rules).getAllByRole('article')).toHaveLength(6);
    expect(within(rules).getAllByRole('switch')).toHaveLength(6);
    expect(screen.queryByText(/Block VPN and proxy/)).toBeNull();
    expect(screen.queryByText(/Check courier record/)).toBeNull();
    expect(screen.queryByText(/Steadfast|Pathao|RedX/)).toBeNull();
    expect(within(rules).getByRole('switch', { name: 'Limit orders per phone' })).not.toBeChecked();
    expect(within(rules).getByText('New numbers only')).toBeInTheDocument();
    expect(within(rules).getByText('Uses SMS credits')).toBeInTheDocument();
    // no connected gateway → note on the advance rule
    expect(await within(rules).findByText(/No payment gateway is connected/)).toBeInTheDocument();

    const blockedCard = screen.getByRole('region', { name: 'Blocked numbers' });
    expect(within(blockedCard).getByRole('heading', { name: 'Blocked numbers · 14' })).toBeInTheDocument();
    const table = await within(blockedCard).findByRole('table', { name: 'Blocked numbers' });
    expect(within(table).getByText('01819-224466')).toBeInTheDocument();
    expect(within(table).getByText('5 returns at your shop')).toBeInTheDocument();
    expect(within(table).getByText('Return rule')).toBeInTheDocument();
    expect(within(table).getByText('Sumi')).toBeInTheDocument();
    expect(within(blockedCard).getByText('Showing 2 of 14')).toBeInTheDocument();
    expect(within(blockedCard).getByRole('link', { name: 'View all blocked numbers' })).toHaveAttribute('href', '/orders/fraud-guard/blocked');

    const recent = screen.getByRole('region', { name: 'Recent decisions' });
    expect(await within(recent).findByText('Held for a call')).toBeInTheDocument();
    expect(within(recent).getByText('Advance asked')).toBeInTheDocument();
    expect(within(recent).getByText('Advance paid')).toBeInTheDocument();
    expect(within(recent).getByText('Limit reached')).toBeInTheDocument();
    expect(within(recent).getByText('Duplicate caught')).toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/orders/fraud-guard/log');
    expect(screen.getByRole('complementary', { name: 'Your data stays yours' })).toHaveTextContent('Records come only from your shop’s own orders');
    expect(screen.queryByText(/Fake order guard is on Starter and Growth/)).toBeNull();
  });

  it('autosaves a toggle and a threshold, and resets to recommended', async () => {
    const fetchMock = signedIn('owner', {
      ...guardRoutes(),
      'PATCH /stores/S1/fraud-guard/settings': (init) => jsonResponse(200, { data: guardSettings(JSON.parse(String(init.body))) }),
      'POST /stores/S1/fraud-guard/settings/reset': jsonResponse(200, { data: guardSettings({ daily_limit_enabled: true }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders/fraud-guard' });
    const rules = await screen.findByRole('region', { name: 'Rules' }, SLOW);
    await userEvent.click(within(rules).getByRole('switch', { name: 'Catch duplicate orders' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/fraud-guard/settings', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/fraud-guard/settings', 'PATCH')[0]!)).toEqual({ duplicates_enabled: false });
    expect(await screen.findByText('Saved. Applies to new orders.')).toBeInTheDocument();

    await userEvent.selectOptions(within(rules).getByRole('combobox', { name: 'Hold when delivery rate is below' }), '55');
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/fraud-guard/settings', 'PATCH')).toHaveLength(2));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/fraud-guard/settings', 'PATCH')[1]!)).toEqual({ hold_below: 55 });
    // the hold line can't pass the advance line
    expect(within(within(rules).getByRole('combobox', { name: 'Hold when delivery rate is below' })).queryByRole('option', { name: '80%' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Reset to recommended' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/fraud-guard/settings/reset', 'POST')).toHaveLength(1));
    expect(await screen.findByText('Rules reset to recommended.')).toBeInTheDocument();
    await waitFor(() => expect(within(rules).getByRole('switch', { name: 'Limit orders per phone' })).toBeChecked());
  });

  it('Check a number shows the own-shop record and leads to Block', async () => {
    const fetchMock = signedIn('owner', {
      ...guardRoutes(),
      'POST /stores/S1/fraud-guard/check': jsonResponse(200, { data: numberCheck() }),
      'POST /stores/S1/fraud-guard/blocked-numbers': jsonResponse(201, { data: { ...blocked({ reason: 'manual', source: 'staff' }), open_orders_count: 1 } }),
    });
    renderApp(<AppRoutes />, { route: '/orders/fraud-guard' });
    await userEvent.click(await screen.findByRole('button', { name: 'Check a number' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Check a number' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check' }));
    expect(within(dialog).getByText('Enter a phone number.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Phone number'), '+88 01819-224466');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check' }));
    const card = await within(dialog).findByRole('region', { name: 'Check result' });
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/fraud-guard/check', 'POST')[0]!)).toEqual({ phone: '8801819224466' });
    expect(within(card).getByText('58%')).toBeInTheDocument();
    expect(within(card).getByText('Risky')).toBeInTheDocument();
    expect(within(card).getByText('12 parcels at your shop · 7 delivered · 5 returned')).toBeInTheDocument();
    expect(within(card).getByText('Last return 9 Nov')).toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: 'Block number' }));
    const block = await screen.findByRole('dialog', { name: 'Block a number' });
    expect(within(block).getByLabelText('Phone number')).toHaveValue('01819-224466');
    await userEvent.type(within(block).getByLabelText('Reason (optional)'), 'Fake name');
    await userEvent.click(within(block).getByRole('button', { name: 'Block number' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/fraud-guard/blocked-numbers', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/fraud-guard/blocked-numbers', 'POST')[0]!)).toEqual({ phone: '8801819224466', note: 'Fake name' });
    expect(await screen.findByText(/1 open order from this number is not cancelled/)).toBeInTheDocument();
  });

  it('Block a number: already blocked and 429 on check', async () => {
    signedIn('owner', {
      ...guardRoutes(),
      'POST /stores/S1/fraud-guard/blocked-numbers': jsonResponse(409, { error: { code: 'already_blocked', message: 'Already blocked.' } }),
      'POST /stores/S1/fraud-guard/check': jsonResponse(429, { error: { code: 'too_many_requests', message: 'Slow down.' } }),
    });
    renderApp(<AppRoutes />, { route: '/orders/fraud-guard' });
    await userEvent.click(await screen.findByRole('button', { name: 'Block a number' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Block a number' });
    await userEvent.type(within(dialog).getByLabelText('Phone number'), '0171234');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Block number' }));
    expect(within(dialog).getByText('Enter a Bangladeshi mobile number like 01712-345678.')).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText('Phone number'));
    await userEvent.type(within(dialog).getByLabelText('Phone number'), '01712345678');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Block number' }));
    expect(await within(dialog).findByText('This number is already blocked.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(screen.getByRole('button', { name: 'Check a number' }));
    const check = await screen.findByRole('dialog', { name: 'Check a number' });
    await userEvent.type(within(check).getByLabelText('Phone number'), '01712345678');
    await userEvent.click(within(check).getByRole('button', { name: 'Check' }));
    expect(await within(check).findByText('You’ve checked a lot of numbers. Wait a minute and try again.')).toBeInTheDocument();
  });

  it('unblock asks first and sends DELETE', async () => {
    const fetchMock = signedIn('owner', { ...guardRoutes(), 'DELETE /stores/S1/fraud-guard/blocked-numbers/BN1': new Response(null, { status: 204 }) });
    renderApp(<AppRoutes />, { route: '/orders/fraud-guard' });
    const table = await screen.findByRole('table', { name: 'Blocked numbers' }, SLOW);
    await userEvent.click(within(table).getByRole('button', { name: 'Unblock 01819-224466' }));
    const confirm = await screen.findByRole('dialog', { name: 'Unblock 01819-224466?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Unblock' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/fraud-guard/blocked-numbers/BN1', 'DELETE')).toHaveLength(1));
    expect(await screen.findByText('01819-224466 unblocked.')).toBeInTheDocument();
  });

  it('empty and error states', async () => {
    signedIn('owner', guardRoutes({
      'GET /stores/S1/fraud-guard/events': jsonResponse(200, { data: [], meta: { next_cursor: null, prev_cursor: null, per_page: 50 } }),
      'GET /stores/S1/fraud-guard/blocked-numbers': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }),
    }));
    renderApp(<AppRoutes />, { route: '/orders/fraud-guard' });
    expect(await screen.findByText('No decisions yet — new orders will appear here.', undefined, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('We couldn’t load blocked numbers', undefined, SLOW)).toBeInTheDocument();
  });

  it('Free plan: plan note, rules read-only, buttons disabled', async () => {
    signedIn('owner', guardRoutes({ 'GET /features': jsonResponse(200, { data: features() }) }));
    renderApp(<AppRoutes />, { route: '/orders/fraud-guard' });
    expect(await screen.findByText(/Fake order guard is on Starter and Growth\./, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings/plan');
    expect(await screen.findByText('Protection off')).toBeInTheDocument();
    const rules = screen.getByRole('region', { name: 'Rules' });
    for (const s of within(rules).getAllByRole('switch')) expect(s).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check a number' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Block a number' })).toBeDisabled();
  });

  it('staff without fraud.manage gets the no-access state', async () => {
    signedIn('staff', guardRoutes());
    renderApp(<AppRoutes />, { route: '/orders/fraud-guard' });
    expect(await screen.findByText('You don’t have access to this page', undefined, SLOW)).toBeInTheDocument();
  });

  it('composed full pages: blocked numbers and decision log', async () => {
    const fetchMock = signedIn('owner', guardRoutes());
    const a = renderApp(<AppRoutes />, { route: '/orders/fraud-guard/blocked' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Blocked numbers · 14' }, SLOW)).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Blocked numbers' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search blocked numbers' }), '466');
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/fraud-guard/blocked-numbers').some(([u]) => new URL(u, 'http://x').searchParams.get('q') === '466')).toBe(true));
    a.unmount();
    renderApp(<AppRoutes />, { route: '/orders/fraud-guard/log' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Guard decisions' }, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('Held for a call')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Decision type' }), 'advance_paid');
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/fraud-guard/events').some(([u]) => new URL(u, 'http://x').searchParams.get('filter[type]') === 'advance_paid')).toBe(true));
  });
});

describe('Orders with the guard (§10.2)', () => {
  const held = orderSummary({ id: 'O2', number: 'GS-1041', guard: guard(), customer: { ...orderSummary().customer, name: 'Tanvir Hasan', risk: { tier: 'risky', rate: 58, delivered: 7, total: 12 } } });
  const fresh = orderSummary({ id: 'O3', number: 'GS-1040', customer: { ...orderSummary().customer, name: 'Sumaiya', risk: { tier: 'new', rate: null, delivered: 0, total: 0 } } });

  it('list: RISK column, hold tag instead of Confirm, Risk filter and "On hold · n" chip', async () => {
    const fetchMock = signedIn('owner', { ...geoRoute, 'GET /stores/S1/orders': orderList([orderSummary(), held, fresh], { ...orderCounts, held: 2 } as typeof orderCounts) });
    renderApp(<AppRoutes />, { route: '/orders' });
    const table = await screen.findByRole('table', { name: 'Orders' }, SLOW);
    expect(await within(table).findByText('Good')).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Risk' })).toBeInTheDocument();
    expect(within(table).getByText('Risky')).toBeInTheDocument();
    expect(within(table).getByText('New buyer')).toBeInTheDocument();
    expect(within(table).getByText('Call first', { selector: 'span' })).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Call first GS-1041' })).toHaveAttribute('href', '/orders/O2');
    expect(within(table).queryByRole('button', { name: 'Confirm GS-1041' })).toBeNull();
    expect(within(table).queryByText('On hold')).toBeNull();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Risk' }), 'risky');
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders').some(([u]) => new URL(u, 'http://x').searchParams.get('filter[risk]') === 'risky')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'On hold · 2' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders').some(([u]) => new URL(u, 'http://x').searchParams.get('filter[guard_hold]') === '1')).toBe(true));
  });

  it('bulk confirm explains orders skipped because they are held', async () => {
    signedIn('owner', {
      ...geoRoute,
      'GET /stores/S1/orders': orderList([orderSummary(), held]),
      'POST /stores/S1/orders/bulk': jsonResponse(200, { data: { action: 'confirm', updated: 1, skipped: [{ id: 'O2', reason: 'order_held' }] } }),
    });
    renderApp(<AppRoutes />, { route: '/orders' });
    const table = await screen.findByRole('table', { name: 'Orders' }, SLOW);
    await within(table).findByText('GS-1041');
    for (const box of within(table).getAllByRole('checkbox').slice(1)) await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm 2 orders' }));
    expect(await screen.findByText('Confirmed 1. 1 skipped — 1 held by the fake order guard.')).toBeInTheDocument();
  });

  it('detail call_first: tags, banner, Delivery record with only Your shop, release and confirm', async () => {
    let released = false;
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/orders/O1': () => jsonResponse(200, { data: order({ guard: released ? guard({ hold: null }) : guard(), contact: { name: 'Tanvir Hasan', phone: '8801819224466', email: null } }) }),
      'POST /stores/S1/orders/O1/guard/release': () => {
        released = true;
        return jsonResponse(200, { data: order({ guard: guard({ hold: null }) }) });
      },
      'POST /stores/S1/orders/O1/confirm': jsonResponse(200, { data: order({ status: 'confirmed', guard: guard({ hold: null }) }) }),
      'GET /features': jsonResponse(200, { data: starter() }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'MU-1042' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('On hold')).toBeNull();
    expect(screen.getAllByText('Call first').length).toBeGreaterThan(0);
    const banner = screen.getByRole('region', { name: 'Next step' });
    expect(within(banner).getByText('Held for a call — only 58% delivered (7 of 12) — below your hold line')).toBeInTheDocument();
    expect(within(banner).getByText(/Call Tanvir Hasan on 01819-224466/)).toBeInTheDocument();
    // Confirm isn't offered while held
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();

    const record = screen.getByRole('region', { name: 'Delivery record' });
    expect(within(record).getByText('58%')).toBeInTheDocument();
    expect(within(record).getByText('7 of 12 parcels delivered')).toBeInTheDocument();
    expect(within(record).getByText('Your shop')).toBeInTheDocument();
    expect(within(record).getByText('7/12')).toBeInTheDocument();
    expect(within(record).queryByText(/Steadfast|Pathao|RedX/)).toBeNull();
    expect(within(record).getAllByTestId(/record-bar-/)).toHaveLength(1);
    expect(within(record).getByRole('button', { name: 'Block this number' })).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole('button', { name: 'Release and confirm' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/orders/O1/confirm', 'POST')).toHaveLength(1));
    expect(byMethod(fetchMock, '/stores/S1/orders/O1/guard/release', 'POST')).toHaveLength(1);
    expect(await screen.findByText('MU-1042 · Released and confirmed.')).toBeInTheDocument();
  });

  it('detail call_first: Cancel as fake preselects the reason; staff sees no Block link', async () => {
    signedIn('staff', { 'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ guard: guard() }) }) });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    const banner = await screen.findByRole('region', { name: 'Next step' }, SLOW);
    expect(within(screen.getByRole('region', { name: 'Delivery record' })).queryByRole('button', { name: 'Block this number' })).toBeNull();
    await userEvent.click(within(banner).getByRole('button', { name: 'Cancel as fake' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Fake order' })).toBeChecked();
  });

  it('detail advance: waiting banner with Confirm without advance / Resend link / Copy payment link', async () => {
    const link = paymentLink({ id: 'L7', amount: 13000 });
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ guard: guard({ hold: 'advance', tier: 'careful', rate: 71, reasons: ['rate_below_advance'], decision: 'advance', payment_link_id: 'L7' }), payment_links: [link] }) }),
      'POST /stores/S1/orders/O1/payment-links/L7/resend': jsonResponse(200, { data: link }),
    });
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    const banner = await screen.findByRole('region', { name: 'Next step' }, SLOW);
    expect(within(banner).getByText('Next step: waiting for ৳ 130 advance')).toBeInTheDocument();
    expect(within(banner).getByText(/Held automatically — this buyer delivered 7 of 12 parcels\. bKash payment link sent/)).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for advance').length).toBeGreaterThan(0);
    // the guard banner replaces the generic active-link banner
    expect(screen.queryByRole('region', { name: 'Payment link' })).toBeNull();
    expect(within(banner).getByRole('button', { name: 'Confirm without advance' })).toBeInTheDocument();
    await userEvent.click(within(banner).getByRole('button', { name: 'Resend link' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/orders/O1/payment-links/L7/resend', 'POST')).toHaveLength(1));
    await userEvent.click(within(banner).getByRole('button', { name: 'Copy payment link' }));
    expect(await screen.findByText('Payment link copied.')).toBeInTheDocument();
  });

  it('detail checking: composed banner and Checking… tag, no actions', async () => {
    signedIn('owner', { 'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ guard: guard({ hold: 'checking', tier: null, rate: null, reasons: [], decision: null, record: null, checked_at: null }) }) }) });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    const banner = await screen.findByRole('region', { name: 'Fake order check' }, SLOW);
    expect(within(banner).getByText('Checking this order…')).toBeInTheDocument();
    expect(within(banner).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    // before the check: the customer's own-shop tier still drives the record card
    expect(within(screen.getByRole('region', { name: 'Delivery record' })).getByText('2 of 2 parcels delivered')).toBeInTheDocument();
  });

  it('release invalidates [tenantId, storeId, "orders"] even when confirm then fails', async () => {
    signedIn('owner', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ guard: guard() }) }),
      'GET /stores/S1/orders': orderList([orderSummary()]),
      'POST /stores/S1/orders/O1/guard/release': jsonResponse(200, { data: order({ guard: guard({ hold: null }) }) }),
      'POST /stores/S1/orders/O1/confirm': jsonResponse(409, { error: { code: 'order_held', message: 'Held.' } }),
    });
    const spy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    const banner = await screen.findByRole('region', { name: 'Next step' }, SLOW);
    await userEvent.click(within(banner).getByRole('button', { name: 'Release and confirm' }));
    await waitFor(() => expect(spy.mock.calls.some(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(['T1', 'S1', 'orders']))).toBe(true));
    expect(spy.mock.calls.some(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(['T1', 'S1', 'fraud-guard']))).toBe(true);
  });

  it('Ask for an advance shows the "why" box', async () => {
    signedIn('owner', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ guard: guard({ hold: null, tier: 'careful', rate: 71, decision: 'none', record: { total: 7, delivered: 5, sources: [{ key: 'shop', delivered: 5, total: 7 }] } }) }) }),
      'GET /stores/S1/payment-gateways': gatewaysResponse([connectedBkash()]),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for an advance' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Ask for an advance' });
    const why = within(dialog).getByLabelText('Why ask for an advance');
    expect(within(why).getByText('Be careful')).toBeInTheDocument();
    expect(why).toHaveTextContent('Only 5 of 7 parcels delivered at your shop. An advance cuts the chance of a return.');
  });
});

describe('Customers with risk (§10.3)', () => {
  const list = (rows: ReturnType<typeof customer>[]) => jsonResponse(200, { data: rows, meta: { current_page: 1, per_page: 25, total: rows.length, last_page: 1, counts: { all: rows.length, new_this_month: 0 } } });

  it('list: Risk column and filter', async () => {
    const fetchMock = signedIn('owner', { 'GET /stores/S1/customers': list([customer({ risk: { tier: 'risky', rate: 40, delivered: 2, total: 5 } }), customer({ id: 'CU2', name: 'Mitu', risk: { tier: 'good', rate: 100, delivered: 4, total: 4 } })]) });
    renderApp(<AppRoutes />, { route: '/customers' });
    const table = await screen.findByRole('table', { name: 'Customers' }, SLOW);
    expect(await within(table).findByText('Risky')).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Risk' })).toBeInTheDocument();
    expect(within(table).getByText('Good')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Risk' }), 'careful');
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/customers').some(([u]) => new URL(u, 'http://x').searchParams.get('filter[risk]') === 'careful')).toBe(true));
  });

  it('detail: RiskBadge and the Block this number card (fraud.manage only); no cross-shop record', async () => {
    const fetchMock = signedIn('owner', {
      ...guardRoutes({ 'GET /stores/S1/fraud-guard/blocked-numbers': jsonResponse(200, { data: [], meta: { next_cursor: null, prev_cursor: null, per_page: 50 } }) }),
      'GET /stores/S1/customers/CU1': jsonResponse(200, { data: customer({ risk: { tier: 'careful', rate: 67, delivered: 4, total: 6 } }) }),
      'POST /stores/S1/fraud-guard/blocked-numbers': jsonResponse(201, { data: { ...blocked({ phone: '8801556120987', phone_masked: '01556•••987' }), open_orders_count: 0 } }),
    });
    const a = renderApp(<AppRoutes />, { route: '/customers/CU1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Farhana Rahman' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Be careful')).toBeInTheDocument();
    expect(screen.queryByText(/across Storeplix/)).toBeNull();
    const card = await screen.findByRole('region', { name: 'Block this number' });
    expect(within(card).getByText('Blocked numbers can’t place COD orders on your shop. You can unblock any time.')).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Block +880 1556-120987' })).toBeEnabled());
    await userEvent.click(within(card).getByRole('button', { name: 'Block +880 1556-120987' }));
    const dialog = await screen.findByRole('dialog', { name: 'Block a number' });
    expect(within(dialog).getByLabelText('Phone number')).toHaveValue('01556-120987');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Block number' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/fraud-guard/blocked-numbers', 'POST')).toHaveLength(1));
    a.unmount();

    vi.unstubAllGlobals();
    signedIn('staff', { 'GET /stores/S1/customers/CU1': jsonResponse(200, { data: customer() }) });
    renderApp(<AppRoutes />, { route: '/customers/CU1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Farhana Rahman' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText('New buyer')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Block this number' })).toBeNull();
  });
});
