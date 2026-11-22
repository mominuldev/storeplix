import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { connectedSteadfast, courier, couriersResponse, pickupLocation } from './couriers.fixtures';
import { geo, settingsWithCommerce, shipping } from './phase5.fixtures';
import { gatewaysResponse } from './phase5b2.fixtures';

// Phase 5b-3 dashboard couriers (PHASE-5B §13 "Dashboard"): Integrations courier cards, connect dialog fields per
// provider, the webhook secret shown once and never re-rendered, booking-rules validation, test/disconnect/402, staff
// hides writes, onboarding 06 cards. API mocked per openapi 1.6.0 §4.6.

const SLOW = { timeout: 5000 };
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => c[1].method === method);
const base = {
  'GET /stores/S1/payment-gateways': gatewaysResponse(),
  'GET /stores/S1/shipping': jsonResponse(200, { data: shipping({ pickup_locations: [pickupLocation(), pickupLocation({ id: 'PL2', name: 'Shop', thana: 'Dhanmondi', is_default: false })] }) }),
};

afterEach(() => vi.unstubAllGlobals());

describe('Integrations courier cards (14:980)', () => {
  it('shows status, mode, sync time and Connect/Manage; Connected chip counts couriers', async () => {
    signedIn('owner', { ...base, 'GET /stores/S1/couriers': couriersResponse([connectedSteadfast(), courier('pathao'), courier('redx', { status: 'error', mode: 'live', credentials_hint: '••••9x' })]) });
    renderApp(<AppRoutes />, { route: '/integrations' });
    const steadfast = await screen.findByRole('article', { name: 'Steadfast Courier' }, SLOW);
    expect(within(steadfast).getByText('Connected')).toBeInTheDocument();
    expect(within(steadfast).getByText('Live mode · Synced 2 min ago · Default')).toBeInTheDocument();
    expect(within(steadfast).getByRole('button', { name: 'Manage Steadfast Courier' })).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Pathao Courier' })).getByRole('button', { name: 'Connect Pathao Courier' })).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'RedX' })).getByText('Needs attention')).toBeInTheDocument();
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connected · 2' }));
    expect(screen.queryByRole('article', { name: 'Pathao Courier' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Steadfast Courier' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Couriers' }));
    expect(screen.queryByRole('article', { name: 'SSLCommerz' })).not.toBeInTheDocument();
  });

  it('staff see couriers read-only', async () => {
    signedIn('staff', { ...base, 'GET /stores/S1/couriers': couriersResponse([connectedSteadfast(), courier('pathao'), courier('redx')]) });
    renderApp(<AppRoutes />, { route: '/integrations' });
    const steadfast = await screen.findByRole('article', { name: 'Steadfast Courier' }, SLOW);
    expect(within(steadfast).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Connect|Manage) / })).not.toBeInTheDocument();
  });

  it('shows an error block when the courier list fails', async () => {
    signedIn('owner', { ...base, 'GET /stores/S1/couriers': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) });
    renderApp(<AppRoutes />, { route: '/integrations' });
    expect(await screen.findByText('We couldn’t load your couriers', {}, SLOW)).toBeInTheDocument();
  });
});

describe('Courier dialog (22:1181, 31:2905)', () => {
  it('Steadfast: credentials → booking rules → webhook secret shown once', async () => {
    let connected = false;
    const saved = connectedSteadfast({ is_default: false, revision: 4, last_synced_at: null });
    const fetchMock = signedIn('owner', {
      ...base,
      'GET /stores/S1/couriers': () => couriersResponse([connected ? saved : courier('steadfast'), courier('pathao'), courier('redx')]),
      'PUT /stores/S1/couriers/steadfast': () => {
        connected = true;
        return jsonResponse(200, { data: saved, meta: { webhook_secret: 'sf_whsec_ONCE_1234567890abcdefghijklmnop' } });
      },
      'PATCH /stores/S1/couriers/steadfast': jsonResponse(200, { data: { ...saved, revision: 5, is_default: true } }),
    });
    renderApp(<AppRoutes />, { route: '/integrations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Steadfast Courier' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Enter your Steadfast credentials' });
    expect(within(dialog).getByText('Step 1 of 3')).toBeInTheDocument();
    // Steadfast: API key + Secret key only; the secret is a password input; Save waits for both.
    expect(within(dialog).queryByLabelText('Client ID')).not.toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: 'Save and test' });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('API key'), ' sf_live_key ');
    await userEvent.type(within(dialog).getByLabelText('Secret key'), 'top-secret');
    expect(within(dialog).getByLabelText('Secret key')).toHaveAttribute('type', 'password');
    await userEvent.click(save);
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/couriers/steadfast', 'PUT')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/couriers/steadfast', 'PUT')[0]!)).toEqual({ mode: 'live', credentials: { api_key: 'sf_live_key', secret_key: 'top-secret' } });

    // Step 2: booking rules. Pickup defaults to the default location; cash to collect is fixed.
    expect(await within(dialog).findByRole('heading', { name: 'Booking rules' })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('top-secret');
    expect(within(dialog).getByLabelText('Pickup from')).toHaveValue('PL1');
    expect(within(dialog).getByLabelText('Cash to collect')).toBeDisabled();
    expect(within(dialog).queryByLabelText('Pathao store')).not.toBeInTheDocument();
    const desc = within(dialog).getByLabelText('Parcel description');
    await userEvent.clear(desc);
    await userEvent.type(desc, '{{items} {{price}');
    const weight = within(dialog).getByLabelText('Default weight');
    await userEvent.clear(weight);
    await userEvent.type(weight, '50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and continue' }));
    expect(within(dialog).getByText('Unknown variable {price}. Use {items} or {order_no}.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a weight from 100 g to 20 kg.')).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/couriers/steadfast', 'PATCH')).toHaveLength(0);
    await userEvent.clear(desc);
    await userEvent.type(desc, '{{order_no} · {{items}');
    expect(within(dialog).getByText(/GS-1039 · Jamdani/)).toBeInTheDocument();
    await userEvent.clear(weight);
    await userEvent.type(weight, '700');
    await userEvent.selectOptions(within(dialog).getByLabelText('Pickup from'), 'PL2');
    await userEvent.click(within(dialog).getByRole('switch', { name: 'Default courier' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/couriers/steadfast', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/couriers/steadfast', 'PATCH')[0]!)).toEqual({
      revision: 4,
      settings: { pickup_location_id: 'PL2', parcel_description: '{order_no} · {items}', default_weight_grams: 700 },
      is_default: true,
    });

    // Step 3: webhook URL + the one-time Bearer token.
    expect(await within(dialog).findByRole('heading', { name: 'Status updates' })).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('https://api.storeplix.com/api/v1/webhooks/steadfast/rk_mugdho')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('sf_whsec_ONCE_1234567890abcdefghijklmnop')).toBeInTheDocument();
    expect(within(dialog).getByText(/we won’t show it again/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Status updates' })).not.toBeInTheDocument());

    // Reopen: the secret is never rendered again, only its hint.
    await userEvent.click(await screen.findByRole('button', { name: 'Manage Steadfast Courier' }));
    const manage = await screen.findByRole('dialog', { name: 'Connection' });
    await userEvent.click(within(manage).getByRole('button', { name: /Status updates/ }));
    expect(within(manage).getByText('••••a91c')).toBeInTheDocument();
    expect(manage).not.toHaveTextContent('sf_whsec_ONCE');
    expect(within(manage).queryByDisplayValue(/sf_whsec_ONCE/)).not.toBeInTheDocument();
  }, 20_000);

  it('Rotate shows the new secret once; leaving the section drops it', async () => {
    const fetchMock = signedIn('owner', {
      ...base,
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast(), courier('pathao'), courier('redx')]),
      'POST /stores/S1/couriers/steadfast/webhook-secret': jsonResponse(200, { data: { webhook_url: 'https://api.storeplix.com/api/v1/webhooks/steadfast/rk_mugdho', webhook_secret: 'ROTATED_secret_value_0001' } }),
    });
    renderApp(<AppRoutes />, { route: '/integrations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Manage Steadfast Courier' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Connection' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Status updates/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Make a new one' }));
    expect(await within(dialog).findByDisplayValue('ROTATED_secret_value_0001')).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/couriers/steadfast/webhook-secret', 'POST')).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: /Booking rules/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /Status updates/ }));
    expect(dialog).not.toHaveTextContent('ROTATED_secret_value_0001');
    expect(within(dialog).queryByDisplayValue('ROTATED_secret_value_0001')).not.toBeInTheDocument();
  }, 15_000);

  it('Pathao: four credential fields, store from pickup-stores, delivery type in the PATCH', async () => {
    let connected = false;
    const saved = courier('pathao', { status: 'connected', mode: 'sandbox', credentials_hint: '••••81c2', revision: 2, webhook_url: 'https://api.storeplix.com/api/v1/webhooks/pathao/rk_mugdho', webhook_secret_hint: '••••77aa' });
    const fetchMock = signedIn('owner', {
      ...base,
      'GET /stores/S1/couriers': () => couriersResponse([courier('steadfast'), connected ? saved : courier('pathao'), courier('redx')]),
      'PUT /stores/S1/couriers/pathao': () => {
        connected = true;
        return jsonResponse(200, { data: saved, meta: { webhook_secret: 'pathao_secret_once' } });
      },
      'GET /stores/S1/couriers/pathao/pickup-stores': jsonResponse(200, { data: [{ id: '70412', name: 'Mugdho Fashion', address: 'Mirpur' }] }),
      'PATCH /stores/S1/couriers/pathao': jsonResponse(200, { data: { ...saved, revision: 3 } }),
    });
    renderApp(<AppRoutes />, { route: '/integrations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Pathao Courier' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Enter your Pathao credentials' });
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Sandbox (test)' }));
    await userEvent.type(within(dialog).getByLabelText('Client ID'), 'cid');
    await userEvent.type(within(dialog).getByLabelText('Client secret'), 'csecret');
    await userEvent.type(within(dialog).getByLabelText('Username (email)'), 'shop@example.com');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'pw');
    expect(within(dialog).getByLabelText('Client secret')).toHaveAttribute('type', 'password');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/couriers/pathao', 'PUT')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/couriers/pathao', 'PUT')[0]!)).toEqual({
      mode: 'sandbox',
      credentials: { client_id: 'cid', client_secret: 'csecret', username: 'shop@example.com', password: 'pw' },
    });
    const store = await within(dialog).findByLabelText('Pathao store', {}, SLOW);
    expect(within(dialog).getByLabelText('Item type')).toBeDisabled();
    // Pathao weight is 0.5–10 kg; the store is required.
    const weight = within(dialog).getByLabelText('Default weight');
    await userEvent.clear(weight);
    await userEvent.type(weight, '12000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and continue' }));
    expect(within(dialog).getByText('Choose your Pathao store.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a weight from 500 g to 10 kg.')).toBeInTheDocument();
    await userEvent.clear(weight);
    await userEvent.type(weight, '1000');
    await userEvent.selectOptions(store, '70412');
    await userEvent.selectOptions(within(dialog).getByLabelText('Delivery type'), '12');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/couriers/pathao', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/couriers/pathao', 'PATCH')[0]!).settings).toEqual({
      pickup_location_id: 'PL1',
      parcel_description: '{items} · {order_no}',
      default_weight_grams: 1000,
      pathao_store_id: '70412',
      delivery_type: 12,
    });
    expect(await within(dialog).findByDisplayValue('pathao_secret_once')).toBeInTheDocument();
    expect(within(dialog).getByText(/Pathao → Developer API → Webhook/)).toBeInTheDocument();
  }, 20_000);

  it('RedX: one token field; status updates explain polling', async () => {
    let connected = false;
    const saved = courier('redx', { status: 'connected', mode: 'live', credentials_hint: '••••t0k', revision: 2 });
    signedIn('owner', {
      ...base,
      'GET /stores/S1/couriers': () => couriersResponse([courier('steadfast'), courier('pathao'), connected ? saved : courier('redx')]),
      'PUT /stores/S1/couriers/redx': () => {
        connected = true;
        return jsonResponse(200, { data: saved });
      },
      'GET /stores/S1/couriers/redx/pickup-stores': jsonResponse(200, { data: [] }),
    });
    renderApp(<AppRoutes />, { route: '/integrations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect RedX' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Enter your RedX credentials' });
    expect(within(dialog).getByLabelText('API access token')).toHaveAttribute('type', 'password');
    expect(within(dialog).queryByLabelText('API key')).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('API access token'), 'eyJ.redx');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    expect(await within(dialog).findByLabelText('RedX pickup store', {}, SLOW)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Skip for now' }));
    expect(await within(dialog).findByText(/check every parcel with RedX every 15 minutes/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
  }, 15_000);

  it('Test connection, courier_busy on disconnect, credentials_invalid on edit keys', async () => {
    const fetchMock = signedIn('owner', {
      ...base,
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast(), courier('pathao'), courier('redx')]),
      'POST /stores/S1/couriers/steadfast/test': jsonResponse(200, { data: { ok: true, checked_at: '2026-11-22T09:00:00Z', balance_amount: 1_250_000 } }),
      'DELETE /stores/S1/couriers/steadfast': jsonResponse(409, { error: { code: 'courier_busy', message: 'Active shipments' } }),
      'PUT /stores/S1/couriers/steadfast': jsonResponse(422, { error: { code: 'credentials_invalid', message: 'Rejected', details: { 'credentials.secret_key': ['Steadfast rejected this key.'] } } }),
    });
    renderApp(<AppRoutes />, { route: '/integrations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Manage Steadfast Courier' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Connection' });
    expect(within(dialog).getByText('••••3f9a')).toBeInTheDocument();
    expect(within(dialog).getByText(/by Rahim Ahmed/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByText(/Connection test passed .* balance ৳ 12,500/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await screen.findByRole('dialog', { name: 'Disconnect Steadfast?' });
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Disconnect Steadfast?' })).getByRole('button', { name: 'Disconnect' }));
    expect(await within(dialog).findByText(/still has parcels on the way/)).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/couriers/steadfast', 'DELETE')).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit keys' }));
    await userEvent.type(within(dialog).getByLabelText('API key'), 'k2');
    await userEvent.type(within(dialog).getByLabelText('Secret key'), 's2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    expect(await within(dialog).findByText('Steadfast rejected this key.')).toBeInTheDocument();
    expect(within(dialog).getByText(/didn’t accept these keys/)).toBeInTheDocument();
  }, 15_000);

  it('402 plan_limit_reached on connect opens the upgrade dialog', async () => {
    signedIn('owner', {
      ...base,
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast(), courier('pathao'), courier('redx')]),
      'PUT /stores/S1/couriers/redx': jsonResponse(402, { error: { code: 'plan_limit_reached', message: 'The Free plan includes 1 courier.' } }),
    });
    renderApp(<AppRoutes />, { route: '/integrations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect RedX' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Enter your RedX credentials' });
    await userEvent.type(within(dialog).getByLabelText('API access token'), 'tok');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and test' }));
    expect(await screen.findByRole('dialog', { name: 'You’ve reached your plan’s limit' })).toHaveTextContent('The Free plan includes 1 courier.');
    expect(screen.queryByRole('dialog', { name: 'Enter your RedX credentials' })).not.toBeInTheDocument();
  });
});

describe('Onboarding 06 courier cards (45:8086, 50:604)', () => {
  it('Connect opens the courier dialog; connected shows the ✓ badge', async () => {
    signedIn('owner', {
      ...base,
      'GET /geo/bd': jsonResponse(200, { data: geo }),
      'GET /stores/S1/settings': settingsWithCommerce(),
      'GET /stores/S1/products': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 1, total: 0, last_page: 1 } }),
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast(), courier('pathao'), courier('redx')]),
    });
    renderApp(<AppRoutes />, { route: '/onboarding/delivery' });
    const steadfast = await screen.findByRole('listitem', { name: 'Steadfast Courier' }, SLOW);
    expect(await within(steadfast).findByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText(/COD settled in 48 h/)).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('listitem', { name: 'Pathao Courier' })).getByRole('button', { name: 'Connect Pathao Courier' }));
    expect(await screen.findByRole('dialog', { name: 'Enter your Pathao credentials' })).toBeInTheDocument();
  });

  it('staff see the cards without Connect', async () => {
    signedIn('staff', {
      ...base,
      'GET /geo/bd': jsonResponse(200, { data: geo }),
      'GET /stores/S1/settings': settingsWithCommerce(),
      'GET /stores/S1/products': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 1, total: 0, last_page: 1 } }),
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast(), courier('pathao'), courier('redx')]),
    });
    renderApp(<AppRoutes />, { route: '/onboarding/delivery' });
    await within(await screen.findByRole('listitem', { name: 'Steadfast Courier' }, SLOW)).findByText('Connected');
    expect(screen.queryByRole('button', { name: /^(Connect|Manage) .*Courier/ })).not.toBeInTheDocument();
  });
});
