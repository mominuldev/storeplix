import type { ApiScope } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { deliveryPill, endpointStatusLine, keySubtitle, planNote, successPill, toggleScope, visibleScopes } from '../developer/developer';
import { can } from '../lib/permissions';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { features } from './phase7.fixtures';
import { apiKey, deliveryDetail, developerRoutes, endpoint, growth, scopes } from './phase8-4.fixtures';

// PHASE-8-4 §10 Web: Developer page renders keys/endpoints/deliveries from fixtures; create key shows the plain key
// once; scope implication + non-grantable disabled; plan note variants; failing pill; permission gating.

const SLOW = { timeout: 5000 };
const page = '/integrations/developer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PHASE-8-4 helpers', () => {
  it('a write ticks and locks its read; unticking the write frees it', () => {
    const cat = scopes();
    let s = toggleScope(new Set(), 'orders:write', cat);
    expect([...s].sort()).toEqual(['orders:read', 'orders:write']);
    s = toggleScope(s, 'orders:read', cat); // locked while the write is on
    expect(s.has('orders:read')).toBe(true);
    s = toggleScope(s, 'orders:write', cat);
    expect([...s]).toEqual(['orders:read']);
    expect(visibleScopes(['orders:read', 'orders:write', 'inventory:read'] as ApiScope[])).toEqual(['orders:write', 'inventory:read']);
  });

  it('success pill tones and the failing label', () => {
    expect(successPill(endpoint({ success_rate_7d: 99.8 }))).toEqual({ label: '99.8%', tone: 'success' });
    expect(successPill(endpoint({ success_rate_7d: 100 }))).toEqual({ label: '100%', tone: 'success' });
    expect(successPill(endpoint({ success_rate_7d: 85 }))).toEqual({ label: '85%', tone: 'warning' });
    expect(successPill(endpoint({ success_rate_7d: 62, failing_since: '2026-11-24T03:40:00Z' }))).toEqual({ label: '62% · failing', tone: 'danger' });
    expect(successPill(endpoint({ success_rate_7d: null })).tone).toBe('neutral');
  });

  it('endpoint line, delivery pill, key subtitle and plan note', () => {
    const fmt = (iso: string) => iso.slice(11, 16);
    expect(endpointStatusLine(endpoint({ last_status: 200 }), () => '2 min ago', fmt)).toEqual({ text: 'Last delivery 2 min ago · 200 OK', danger: false });
    expect(endpointStatusLine(endpoint({ failing_since: '2026-11-24T09:40:00Z', last_status: 503 }), () => '', fmt)).toEqual({ text: 'Failing since 09:40 · 503 Service unavailable', danger: true });
    expect(deliveryPill({ status: 'failed', response_status: null, error_code: 'timeout' })).toEqual({ label: 'Timeout', tone: 'danger' });
    expect(deliveryPill({ status: 'succeeded', response_status: 204, error_code: null })).toEqual({ label: '204', tone: 'success' });
    expect(keySubtitle(apiKey())).toBe('Created 2 Oct by Rafiqul');
    expect(keySubtitle(apiKey({ status: 'revoked', revoked_at: '2026-11-12T09:00:00Z' }))).toBe('Revoked 12 Nov');
    expect(planNote(features())).toEqual({ kind: 'locked' });
    expect(planNote(growth())).toBeNull();
    expect(planNote(growth({ subscription_status: 'trialing', trial_ends_at: '2026-12-03T10:00:00Z' }))).toEqual({ kind: 'trial', until: '3 Dec 2026' });
  });

  it('can.manageDevelopers reads developers.manage; staff never has it', () => {
    expect(can.manageDevelopers({ role: 'custom', permissions: ['developers.manage'] })).toBe(true);
    expect(can.manageDevelopers({ role: 'custom', permissions: ['integrations.manage'] })).toBe(false);
    expect(can.manageDevelopers({ role: 'staff' })).toBe(false);
    expect(can.manageDevelopers({ role: 'admin' })).toBe(true);
  });
});

describe('Developer page', () => {
  it('renders keys, endpoints, secret and recent deliveries from fixtures', async () => {
    signedIn('owner', developerRoutes());
    renderApp(<AppRoutes />, { route: page });
    expect(await screen.findByRole('heading', { level: 1, name: 'Developer · API & webhooks' }, SLOW)).toBeInTheDocument();

    const keysCard = screen.getByRole('region', { name: 'API keys' });
    const keyRows = await within(keysCard).findAllByRole('row');
    expect(keyRows).toHaveLength(4); // header + 3
    expect(within(keyRows[1]!).getByText('Tally accounting sync')).toBeInTheDocument();
    expect(within(keyRows[1]!).getByText('Created 2 Oct by Rafiqul')).toBeInTheDocument();
    expect(within(keyRows[1]!).getByText('sp_live_••••7f2a')).toBeInTheDocument();
    expect(within(keyRows[1]!).getByText('Orders · read')).toBeInTheDocument();
    expect(within(keyRows[1]!).getByText('2 min ago')).toBeInTheDocument();
    // Implied read hidden next to its write.
    expect(within(keyRows[2]!).getByText('Orders · write')).toBeInTheDocument();
    expect(within(keyRows[2]!).queryByText('Orders · read')).not.toBeInTheDocument();
    expect(within(keyRows[3]!).getByText('Revoked')).toBeInTheDocument();
    expect(within(keyRows[3]!).getByText('Revoked 12 Nov')).toBeInTheDocument();
    expect(within(keyRows[3]!).getByText('—')).toBeInTheDocument();

    const hooks = screen.getByRole('region', { name: 'Webhooks' });
    const rows = await within(hooks).findAllByRole('row');
    expect(within(rows[1]!).getByText('Last delivery 2 min ago · 200 OK')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('+2')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('99.8%')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('62% · failing')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/^Failing since \d\d:\d\d · 503 Service unavailable$/)).toBeInTheDocument();
    expect(within(hooks).getByText('Events you can send:')).toBeInTheDocument();

    expect(await screen.findByText('whsec_••••3kQ9')).toBeInTheDocument();
    const recent = screen.getByRole('region', { name: 'Recent deliveries' });
    expect(await within(recent).findByText('order.created · GS-1048')).toBeInTheDocument();
    expect(within(recent).getByText('503')).toBeInTheDocument();
    expect(await within(recent).findByRole('button', { name: 'Resend failed (1)' })).toBeEnabled();
    expect(screen.getByText('120 requests / minute per key')).toBeInTheDocument();
    expect(screen.queryByText('Postman collection')).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('create key: implied read locks, non-grantable disabled, plain key shown once', async () => {
    const user = userEvent.setup();
    let body: unknown;
    const fetchMock = signedIn('owner', {
      ...developerRoutes({ scopes: scopes(['customers:read']) }),
      'POST /api-keys': (init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse(201, { data: { ...apiKey({ id: 'K9', name: 'Zapier' }), plain_key: 'sp_live_0123456789abcdefghijABCDEFGHIJ0123456789' } });
      },
    });
    renderApp(<AppRoutes />, { route: page });
    await user.click(await screen.findByRole('button', { name: '+ Create API key' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Create API key' });
    await user.type(within(dialog).getByLabelText('Name'), 'Zapier');
    const write = await within(dialog).findByRole('checkbox', { name: 'Orders · write' });
    await user.click(write);
    expect(within(dialog).getByRole('checkbox', { name: 'Orders · read' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Orders · read' })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'Customers · read' })).toBeDisabled();
    // Owner holds costs.view → the include-costs option is offered.
    expect(within(dialog).getByRole('checkbox', { name: 'Include cost prices' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));

    const once = await screen.findByRole('dialog', { name: 'Copy your API key' });
    expect(within(once).getByDisplayValue('sp_live_0123456789abcdefghijABCDEFGHIJ0123456789')).toBeInTheDocument();
    expect(within(once).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(body).toEqual({ name: 'Zapier', scopes: ['orders:write', 'orders:read'], include_costs: false });
    await user.click(within(once).getByRole('button', { name: "I've stored it" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(/sp_live_0123/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sp_live_0123/)).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/api-keys').length).toBeGreaterThan(1); // list refetched (no secret in cache)
  });

  it('create key without costs.view hides the costs option; validation needs a name and a scope', async () => {
    const user = userEvent.setup();
    signedIn({ role: 'custom', role_name: 'Integrator', permissions: ['developers.manage', 'orders.view'] }, developerRoutes({ scopes: scopes(['orders:write', 'products:write', 'inventory:write', 'customers:read']) }));
    renderApp(<AppRoutes />, { route: page });
    await user.click(await screen.findByRole('button', { name: '+ Create API key' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Create API key' });
    await within(dialog).findByRole('checkbox', { name: 'Orders · read' });
    expect(within(dialog).queryByRole('checkbox', { name: 'Include cost prices' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Orders · write' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText('Give the key a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('Pick at least one kind of access.')).toBeInTheDocument();
  });

  it('revoke asks first, then marks the row revoked', async () => {
    const user = userEvent.setup();
    signedIn('owner', {
      ...developerRoutes(),
      'DELETE /api-keys/K1': jsonResponse(200, { data: apiKey({ status: 'revoked', revoked_at: new Date().toISOString() }) }),
    });
    renderApp(<AppRoutes />, { route: page });
    await user.click(await screen.findByRole('button', { name: 'Actions for Tally accounting sync' }, SLOW));
    await user.click(screen.getByRole('menuitem', { name: 'Revoke…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke “Tally accounting sync”?' });
    await user.click(within(confirm).getByRole('button', { name: 'Revoke key' }));
    const keysCard = screen.getByRole('region', { name: 'API keys' });
    await waitFor(() => expect(within(within(keysCard).getAllByRole('row')[1]!).getByText('Revoked')).toBeInTheDocument());
  });

  it('add endpoint: select all events, URL refused by the API shows inline', async () => {
    const user = userEvent.setup();
    let body: { events?: string[] } = {};
    signedIn('owner', {
      ...developerRoutes(),
      'POST /stores/S1/webhook-endpoints': (init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse(422, { error: { code: 'webhook_url_not_allowed', message: 'Not allowed.' } });
      },
    });
    renderApp(<AppRoutes />, { route: page });
    await user.click(await screen.findByRole('button', { name: '+ Add endpoint' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Add endpoint' });
    const url = within(dialog).getByLabelText('Endpoint URL');
    await user.clear(url);
    await user.type(url, 'https://10.0.0.1/hook');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Select all' }));
    expect(within(dialog).getByRole('checkbox', { name: 'stock.low' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));
    expect(await within(dialog).findByText(/This URL can’t receive webhooks/)).toBeInTheDocument();
    expect(body.events).toHaveLength(10);
  });

  it('reveal shows the full secret; rotate confirms and shows the new secret once', async () => {
    const user = userEvent.setup();
    const revealed = { last_four: '3kQ9', masked: 'whsec_••••3kQ9', rotated_at: null, previous_expires_at: null, secret: 'whsec_abcdefghijklmnopqrstuvwxyz123kQ9' };
    signedIn('owner', {
      ...developerRoutes(),
      'POST /stores/S1/webhook-secret/reveal': jsonResponse(200, { data: revealed }),
      'POST /stores/S1/webhook-secret/rotate': jsonResponse(200, { data: { ...revealed, last_four: 'Zz99', masked: 'whsec_••••Zz99', secret: 'whsec_NEWSECRETNEWSECRETNEWSECRETZz99', previous_expires_at: new Date(Date.now() + 86_400_000).toISOString() } }),
    });
    renderApp(<AppRoutes />, { route: page });
    await user.click(await screen.findByRole('button', { name: 'Show secret' }, SLOW));
    expect(await screen.findByText('whsec_abcdefghijklmnopqrstuvwxyz123kQ9')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide secret' }));
    expect(screen.getByText('whsec_••••3kQ9')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
    const confirm = await screen.findByRole('dialog', { name: 'Rotate the signing secret?' });
    expect(within(confirm).getByText(/next 24 hours/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Rotate secret' }));
    const shown = await screen.findByRole('dialog', { name: 'Your new signing secret' });
    expect(within(shown).getByDisplayValue('whsec_NEWSECRETNEWSECRETNEWSECRETZz99')).toBeInTheDocument();
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('whsec_••••Zz99')).toBeInTheDocument();
    expect(screen.queryByText(/NEWSECRET/)).not.toBeInTheDocument();
  });

  it('deliveries log opens a delivery with payload and resends it', async () => {
    const user = userEvent.setup();
    const fetchMock = signedIn('owner', {
      ...developerRoutes(),
      'GET /stores/S1/webhook-deliveries/D1': jsonResponse(200, { data: deliveryDetail() }),
      'POST /stores/S1/webhook-deliveries/D1/resend': jsonResponse(202, { data: { ...deliveryDetail(), id: 'D9' } }),
      'GET /stores/S1/webhook-deliveries/D9': jsonResponse(200, { data: deliveryDetail({ id: 'D9' }) }),
    });
    renderApp(<AppRoutes />, { route: page });
    const recent = await screen.findByRole('region', { name: 'Recent deliveries' }, SLOW);
    await user.click(within(recent).getByRole('button', { name: 'Log' }));
    const drawer = await screen.findByRole('dialog', { name: 'Delivery log' });
    await user.click(await within(drawer).findByRole('button', { name: /order\.created · GS-1048/ }));
    const detail = await screen.findByRole('dialog', { name: 'Delivery' });
    expect(await within(detail).findByText(/"number": "GS-1048"/)).toBeInTheDocument();
    expect(within(detail).getByText(/X-Storeplix-Signature: \[redacted\]/)).toBeInTheDocument();
    await user.click(within(detail).getByRole('button', { name: 'Resend' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/webhook-deliveries/D1/resend')).toHaveLength(1));
  });

  it('empty states for keys and endpoints', async () => {
    signedIn('owner', developerRoutes({ keys: [], endpoints: [], deliveries: [] }));
    renderApp(<AppRoutes />, { route: page });
    expect(await screen.findByText('No API keys yet', undefined, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('No endpoints yet')).toBeInTheDocument();
    expect(await screen.findByText(/No deliveries yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resend failed/ })).not.toBeInTheDocument();
  });

  it('error state with retry', async () => {
    signedIn('owner', { ...developerRoutes(), 'GET /api-keys': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) });
    renderApp(<AppRoutes />, { route: page });
    expect(await screen.findByText('We couldn’t load your API keys', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });
});

describe('Plan note and gating', () => {
  it('without api_webhooks: Growth note, See plans, every create action disabled', async () => {
    signedIn('owner', developerRoutes({ features: features() }));
    renderApp(<AppRoutes />, { route: page });
    const note = await screen.findByRole('note', undefined, SLOW);
    expect(note).toHaveTextContent(/^API keys and webhooks are part of the Growth plan\.See plans$/);
    expect(within(note).getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings/plan');
    expect(screen.getByRole('button', { name: '+ Create API key' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ New key' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Add endpoint' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rotate secret' })).toBeDisabled();
  });

  it('trial copy names the end date', async () => {
    signedIn('owner', developerRoutes({ features: growth({ subscription_status: 'trialing', trial_ends_at: '2026-12-03T10:00:00Z' }) }));
    renderApp(<AppRoutes />, { route: page });
    expect(await screen.findByRole('note', undefined, SLOW)).toHaveTextContent('API keys and webhooks are part of the Growth plan. You’re trying them free until 3 Dec 2026.');
    expect(screen.getByRole('button', { name: '+ Create API key' })).toBeEnabled();
  });

  it('staff get the no-access state and no Developer banner on Integrations', async () => {
    signedIn('staff', developerRoutes());
    renderApp(<AppRoutes />, { route: page });
    expect(await screen.findByText('You don’t have access to this page', undefined, SLOW)).toBeInTheDocument();
  });

  it('Integrations list shows the Developer banner only with developers.manage', async () => {
    signedIn('admin', { ...developerRoutes(), 'GET /stores/S1/payment-gateways': jsonResponse(200, { data: [] }), 'GET /stores/S1/couriers': jsonResponse(200, { data: [] }) });
    const { unmount } = renderApp(<AppRoutes />, { route: '/integrations' });
    const banner = await screen.findByRole('region', { name: 'Developer' }, SLOW);
    expect(within(banner).getByRole('link', { name: 'Developer: API keys and webhooks' })).toHaveAttribute('href', '/integrations/developer');
    expect(within(banner).getByRole('link', { name: 'Create API key' })).toHaveAttribute('href', '/integrations/developer?create=key');
    unmount();

    signedIn({ role: 'custom', role_name: 'Ops', permissions: ['integrations.manage'] }, { 'GET /stores/S1/payment-gateways': jsonResponse(200, { data: [] }), 'GET /stores/S1/couriers': jsonResponse(200, { data: [] }) });
    renderApp(<AppRoutes />, { route: '/integrations' });
    expect(await screen.findByRole('heading', { name: 'Integrations' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Developer' })).not.toBeInTheDocument();
  });

  it('?create=key from the banner opens the create dialog', async () => {
    signedIn('owner', developerRoutes());
    renderApp(<AppRoutes />, { route: `${page}?create=key` });
    expect(await screen.findByRole('dialog', { name: 'Create API key' }, SLOW)).toBeInTheDocument();
  });
});
