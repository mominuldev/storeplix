import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { order, settingsWithCommerce } from './phase5.fixtures';
import { connectedBkash, gateway, gatewaysResponse, onlineCharge, paymentLink } from './phase5b2.fixtures';

// Phase 5b-2 dashboard (PHASE-5B §13 "Dashboard"): connect dialogs (fields per provider, secrets never re-rendered,
// steps), ask-for-advance amounts (25 % of due, delivery charge, custom bounds), staff hides integration writes and
// refunds. API mocked per openapi 1.6.0.

const SLOW = { timeout: 5000 };
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const headerOf = (call: [string, RequestInit], name: string) => (call[1].headers as Record<string, string>)[name];
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => c[1].method === method);

afterEach(() => vi.unstubAllGlobals());

describe('Integrations (14:980)', () => {
  it('lists payments live; filter chips count (couriers: see couriers.screens.test)', async () => {
    signedIn('owner', { 'GET /stores/S1/payment-gateways': gatewaysResponse([connectedBkash(), gateway('sslcommerz')]), 'GET /stores/S1/couriers': jsonResponse(200, { data: [] }) });
    renderApp(<AppRoutes />, { route: '/integrations' });
    const bkash = await screen.findByRole('article', { name: 'bKash Payment Gateway' }, SLOW);
    expect(within(bkash).getByText('Connected')).toBeInTheDocument();
    expect(within(bkash).getByText(/Sandbox · On at checkout · Default/)).toBeInTheDocument();
    expect(within(bkash).getByRole('button', { name: 'Manage bKash Payment Gateway' })).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'SSLCommerz' })).getByRole('button', { name: 'Connect SSLCommerz' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connected · 1' }));
    expect(screen.queryByRole('article', { name: 'SSLCommerz' })).not.toBeInTheDocument();
  });

  it('staff see the page read-only (no Connect or Manage)', async () => {
    signedIn('staff', { 'GET /stores/S1/payment-gateways': gatewaysResponse([connectedBkash(), gateway('sslcommerz')]) });
    renderApp(<AppRoutes />, { route: '/integrations' });
    await screen.findByRole('article', { name: 'bKash Payment Gateway' }, SLOW);
    expect(screen.getByText('Only owners and managers can connect or change integrations.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Connect|Manage) / })).not.toBeInTheDocument();
  });
});

describe('Connect gateway wizard (32:3770)', () => {
  it('bKash: 4 steps, PUTs the credentials, clears secrets, tests and goes live', async () => {
    let verified = false;
    let connected = false;
    const win = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => win));
    const saved = connectedBkash({ enabled: false, is_default: false, revision: 4 });
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/payment-gateways': () => gatewaysResponse([!connected ? gateway('bkash') : verified ? { ...saved, verified_at: '2026-11-22T09:00:00Z' } : saved, gateway('sslcommerz')]),
      'PUT /stores/S1/payment-gateways/bkash': () => {
        connected = true;
        return jsonResponse(200, { data: saved });
      },
      'POST /stores/S1/payment-gateways/bkash/test-payment': () => {
        verified = true;
        return jsonResponse(201, { data: { payment_id: 'PT1', redirect_url: 'https://sandbox.bka.sh/pay/PT1' } });
      },
      'PATCH /stores/S1/payment-gateways/bkash': jsonResponse(200, { data: { ...saved, enabled: true, is_default: true } }),
    });
    renderApp(<AppRoutes />, { route: '/integrations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect bKash Payment Gateway' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Before you start' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    // Step 2: four bKash fields; the two secrets are password inputs; Save is disabled until all are filled.
    expect(within(dialog).getByText('Step 2 of 4')).toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: 'Save and test' });
    expect(save).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Live' }));
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Sandbox (test)' }));
    await userEvent.type(within(dialog).getByLabelText('App key'), '4f6o0cjiki2rfm34kfdadl1eqq');
    await userEvent.type(within(dialog).getByLabelText('App secret'), 'super-secret');
    await userEvent.type(within(dialog).getByLabelText('Username'), 'sandboxUser02');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'p@ss');
    expect(within(dialog).getByLabelText('App secret')).toHaveAttribute('type', 'password');
    expect(within(dialog).getByLabelText('Password')).toHaveAttribute('type', 'password');
    await userEvent.click(save);
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/payment-gateways/bkash', 'PUT')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/payment-gateways/bkash', 'PUT')[0]!)).toEqual({
      mode: 'sandbox',
      credentials: { app_key: '4f6o0cjiki2rfm34kfdadl1eqq', app_secret: 'super-secret', username: 'sandboxUser02', password: 'p@ss' },
    });

    // Step 3: secrets are gone; going back shows empty fields with only the saved hint.
    expect(await within(dialog).findByText('Step 3 of 4')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByLabelText('App secret')).toHaveValue('');
    expect(within(dialog).getByLabelText('Password')).toHaveValue('');
    expect(within(dialog).getByText('••••3f9a')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('super-secret');
    await userEvent.click(within(dialog).getByRole('button', { name: /Test payment/ }));

    // Test payment: opens the gateway page in the tab we opened on click, then polls until verified_at moves.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start test payment' }));
    await waitFor(() => expect(win.location.href).toBe('https://sandbox.bka.sh/pay/PT1'));
    expect(win.opener).toBeNull();
    const test = byMethod(fetchMock, '/stores/S1/payment-gateways/bkash/test-payment', 'POST')[0]!;
    expect(headerOf(test, 'Idempotency-Key')).toBeTruthy();
    expect(await within(dialog).findByText(/Test payment received/, {}, { timeout: 6000 })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    // Step 4: go live (enabled + default by default for the first gateway).
    expect(within(dialog).getByRole('switch', { name: 'Show at checkout' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/payment-gateways/bkash', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/payment-gateways/bkash', 'PATCH')[0]!)).toEqual({ revision: 4, enabled: true, is_default: true });
  }, 20_000);

  it('SSLCommerz asks for Store ID and Store password only; 422 credentials_invalid is shown', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/payment-gateways': gatewaysResponse(),
      'PUT /stores/S1/payment-gateways/sslcommerz': jsonResponse(422, { error: { code: 'credentials_invalid', message: 'Rejected', details: { 'credentials.store_passwd': ['Wrong password.'] } } }),
    });
    renderApp(<AppRoutes />, { route: '/integrations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect SSLCommerz' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Before you start' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByLabelText('Store ID')).not.toHaveAttribute('type', 'password');
    expect(within(dialog).getByLabelText('Store password')).toHaveAttribute('type', 'password');
    expect(within(dialog).queryByLabelText('App key')).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Store ID'), 'teststore01');
    await userEvent.type(within(dialog).getByLabelText('Store password'), 'nope');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('SSLCommerz didn’t accept these keys');
    expect(within(dialog).getByText('Wrong password.')).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/payment-gateways/sslcommerz', 'PUT')).toHaveLength(1);
  });
});

describe('Settings → Payments & checkout (60:14865)', () => {
  it('advance toggle needs a usable gateway; per-gateway checkout toggle PATCHes enabled', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/settings': settingsWithCommerce(),
      'PATCH /stores/S1/settings': settingsWithCommerce({ checkout: { cod_enabled: true, cod_advance: 'delivery_charge' } }),
      'GET /stores/S1/payment-gateways': gatewaysResponse([connectedBkash(), gateway('sslcommerz')]),
      'PATCH /stores/S1/payment-gateways/bkash': jsonResponse(200, { data: connectedBkash({ enabled: false, revision: 4 }) }),
    });
    renderApp(<AppRoutes />, { route: '/settings/payments' });
    const advance = await screen.findByRole('switch', { name: 'Advance delivery charge' }, SLOW);
    await waitFor(() => expect(advance).toBeEnabled());
    await userEvent.click(advance);
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/settings', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/settings', 'PATCH')[0]!)).toEqual({ checkout: { cod_advance: 'delivery_charge' } });
    await userEvent.click(screen.getByRole('switch', { name: 'bKash at checkout' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/payment-gateways/bkash', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/payment-gateways/bkash', 'PATCH')[0]!)).toEqual({ revision: 3, enabled: false });
  });
});

describe('Order detail payments (33:3676, 144:46081)', () => {
  const routes = (o = order({ status: 'confirmed' })) => ({
    'GET /stores/S1/settings': settingsWithCommerce(),
    'GET /stores/S1/orders/O1': jsonResponse(200, { data: o }),
    'GET /stores/S1/payment-gateways': gatewaysResponse([connectedBkash(), gateway('sslcommerz')]),
    'POST /stores/S1/orders/O1/payment-links': jsonResponse(201, { data: paymentLink({ amount_kind: 'custom', amount: 50_000 }) }),
  });

  it('ask for an advance: delivery charge, 25 % of due, custom bounds, then sends', async () => {
    const fetchMock = signedIn('owner', routes());
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for an advance' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Ask for an advance' });
    // Due ৳ 1,770, delivery ৳ 70 (fixture).
    expect(within(dialog).getByRole('radio', { name: /Delivery charge/ })).toBeChecked();
    expect(within(dialog).getByText('৳ 70', { selector: 'span' })).toBeInTheDocument();
    expect(within(dialog).getByText('৳ 442.50')).toBeInTheDocument();
    expect(within(dialog).getByText('৳ 1,770', { selector: 'label span' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Part payment/ }));
    const pct = within(dialog).getByLabelText('Part payment (%)');
    await userEvent.clear(pct);
    await userEvent.type(pct, '50');
    expect(within(dialog).getByText('৳ 885')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Custom amount/ }));
    const custom = within(dialog).getByLabelText('Amount');
    await userEvent.type(custom, '2000');
    expect(within(dialog).getByText('Up to ৳ 1,770 — what’s still due.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Send payment link' })).toBeDisabled();
    await userEvent.clear(custom);
    await userEvent.type(custom, '0.5');
    expect(within(dialog).getByText('Ask for at least ৳ 1.')).toBeInTheDocument();
    await userEvent.clear(custom);
    await userEvent.type(custom, '500');
    expect(within(dialog).getByLabelText('SMS preview')).toHaveTextContent('অর্ডার MU-1042 নিশ্চিত করতে 500 টাকা পরিশোধ করুন');
    await userEvent.selectOptions(within(dialog).getByLabelText('Link expires in'), '1440');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send payment link' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/orders/O1/payment-links', 'POST')).toHaveLength(1));
    const call = byMethod(fetchMock, '/stores/S1/orders/O1/payment-links', 'POST')[0]!;
    expect(bodyOf(call)).toEqual({ amount_kind: 'custom', percent_bps: null, amount: 50_000, provider: 'bkash', expires_in_minutes: 1440, cancel_if_unpaid: true, send_sms: true });
    expect(headerOf(call, 'Idempotency-Key')).toBeTruthy();
  });

  it('copy link instead creates without SMS and copies the URL', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const fetchMock = signedIn('owner', { ...routes(), 'POST /stores/S1/orders/O1/payment-links': jsonResponse(201, { data: paymentLink() }) });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for an advance' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Ask for an advance' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy link instead' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/orders/O1/payment-links', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/orders/O1/payment-links', 'POST')[0]!)).toMatchObject({ amount_kind: 'delivery_charge', send_sms: false });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://mugdho.storeplix.com/pay/AbC123xYz789'));
  });

  it('active link banner: resend and cancel; no second advance', async () => {
    const fetchMock = signedIn('owner', {
      ...routes(order({ status: 'pending', payment_links: [paymentLink()] })),
      'POST /stores/S1/orders/O1/payment-links/L1/resend': jsonResponse(200, { data: paymentLink() }),
      'DELETE /stores/S1/orders/O1/payment-links/L1': jsonResponse(204),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    const banner = await screen.findByRole('region', { name: 'Payment link' }, SLOW);
    expect(banner).toHaveTextContent('Waiting for ৳ 70 by bKash');
    expect(screen.queryByRole('button', { name: 'Ask for an advance' })).not.toBeInTheDocument();
    await userEvent.click(within(banner).getByRole('button', { name: 'Resend' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/orders/O1/payment-links/L1/resend', 'POST')).toHaveLength(1));
    await userEvent.click(within(banner).getByRole('button', { name: 'Cancel link' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Cancel this payment link?' })).getByRole('button', { name: 'Cancel link' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/orders/O1/payment-links/L1', 'DELETE')).toHaveLength(1));
  });

  const paidOnline = () =>
    order({ status: 'confirmed', payment_status: 'partially_paid', paid_amount: 7_000, due_amount: 170_000, payments: [onlineCharge()], payment_links: [paymentLink({ status: 'paid' })] });

  it('owner refunds a bKash charge through the gateway; cancel offers the gateway refund', async () => {
    const fetchMock = signedIn('owner', {
      ...routes(paidOnline()),
      'POST /stores/S1/orders/O1/refunds': jsonResponse(201, { data: onlineCharge({ id: 'RF1', type: 'refund', status: 'pending', amount: 5_000, method: 'gateway' }) }),
      'POST /stores/S1/orders/O1/cancel': jsonResponse(200, { data: order({ status: 'cancelled' }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    const payments = await screen.findByRole('region', { name: 'Payments' }, SLOW);
    expect(within(payments).getByText(/TrxID BKX7Q2M9/)).toBeInTheDocument();
    await userEvent.click(within(payments).getByRole('button', { name: /^Refund ৳ 70 bKash payment$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Refund to bKash' });
    const amount = within(dialog).getByLabelText('Amount');
    await userEvent.clear(amount);
    await userEvent.type(amount, '50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/orders/O1/refunds', 'POST')).toHaveLength(1));
    const refund = byMethod(fetchMock, '/stores/S1/orders/O1/refunds', 'POST')[0]!;
    expect(bodyOf(refund)).toEqual({ amount: 5_000, method: 'gateway', payment_id: 'PAY9' });
    expect(headerOf(refund, 'Idempotency-Key')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    const cancel = await screen.findByRole('dialog', { name: 'Cancel order MU-1042?' });
    expect(within(cancel).queryByRole('radio', { name: 'Not paid in time' })).not.toBeInTheDocument();
    expect(within(cancel).getByLabelText('Refund ৳ 70 to bKash')).toBeChecked();
    await userEvent.click(within(cancel).getByRole('radio', { name: 'Customer asked to cancel' }));
    await userEvent.click(within(cancel).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/orders/O1/cancel', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/orders/O1/cancel', 'POST')[0]!)).toMatchObject({ reason: 'customer_request', refund_to_gateway: true });
  });

  it('staff can ask for an advance but never see refund actions', async () => {
    signedIn('staff', routes({ ...paidOnline(), can: { edit: true, cancel: false, refund: false } }));
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    const payments = await screen.findByRole('region', { name: 'Payments' }, SLOW);
    expect(within(payments).getByText(/TrxID BKX7Q2M9/)).toBeInTheDocument();
    expect(within(payments).queryByRole('button', { name: /Refund/ })).not.toBeInTheDocument();
    expect(within(payments).getByRole('button', { name: 'Ask for an advance' })).toBeInTheDocument();
  });
});
