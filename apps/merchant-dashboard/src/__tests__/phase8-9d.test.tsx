import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { impersonation } from '../impersonation/store';
import { oauthNavigation } from '../integrations/FeedPage';
import {
  attentionText,
  eventErrorText,
  eventStatusMeta,
  idProblem,
  integrationErrorText,
  maskedHint,
  normalizeId,
  parseTab,
  PIXEL_TABS,
  PROVIDER_BY_SLUG,
  SLUG_BY_PROVIDER,
  taggingUrlChecks,
  taggingUrlProblem,
  testCodeProblem,
} from '../integrations/integrations';
import { callsTo, jsonResponse, renderApp, signedIn, tenantA, user } from '../test/utils';
import { check, connected, cursorMeta, feedOverview, integration, item, itemMeta, logEntry, run, stats, summary } from './phase8-9d.fixtures';
import { ApiError } from '@storeplix/api-client';

// PHASE-8-9D §16 Web (part A): helpers (IDs, pasted code, GTM URL rules, masks, statuses), Integrations list groups +
// chips + plan badges, pixel connect steps with pasted-code errors, write-only "Replace" secret (no Show), event log
// filters, test mode + polling, settings PATCH with revision, typed DISCONNECT, feed OAuth start/return, account chooser,
// items + issues drawer → product editor, sync now 409, website claim, plan gating, permissions, impersonation.

vi.setConfig({ testTimeout: 20_000 });
const SLOW = { timeout: 5000 };

afterEach(() => {
  vi.restoreAllMocks();
  impersonation.set(null);
});

const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const searchOf = (call: [string, RequestInit]) => new URL(String(call[0]), 'http://localhost').searchParams;
const ok = (data: unknown, meta?: unknown) => jsonResponse(200, meta === undefined ? { data } : { data, meta });
const err = (status: number, code: string, details?: Record<string, unknown>) => jsonResponse(status, { error: { code, message: code, details } });

const listRoutes = (list = [summary('meta_pixel'), summary('ga4', { status: 'connected', summary: 'G-7K2QX9M4LP · purchases from server' }), summary('tiktok_pixel'), summary('gtm_server', { plan_required: 'server_side_tagging' }), summary('meta_catalog', { status: 'connected' }), summary('google_merchant', { status: 'needs_attention', attention: [{ reason: 'items_with_issues', count: 4, since: '2026-11-28T00:00:00Z' }] })]) => ({
  'GET /stores/S1/payment-gateways': ok([]),
  'GET /stores/S1/couriers': ok([]),
  'GET /stores/S1/integrations': ok(list),
});

const ga4Connected = () => connected('ga4', { measurement_id: 'G-7K2QX9M4LP' }, { credentials_hint: { api_secret: '••••3fQa' } });
const pixelRoutes = (row: unknown, provider = 'ga4', extra: Record<string, Response | ((init: RequestInit) => Response)> = {}) => ({
  [`GET /stores/S1/integrations/${provider}`]: ok(row),
  [`GET /stores/S1/integrations/${provider}/stats`]: ok(stats()),
  [`GET /stores/S1/integrations/${provider}/events`]: ok([logEntry()], cursorMeta()),
  ...extra,
});

describe('PHASE-8-9D helpers', () => {
  it('maps Figma slugs to provider values both ways', () => {
    expect(SLUG_BY_PROVIDER.tiktok_pixel).toBe('tiktok');
    expect(PROVIDER_BY_SLUG['google-merchant']).toBe('google_merchant');
    expect(PROVIDER_BY_SLUG.gtm).toBe('gtm_server');
  });

  it('refuses pasted code and wrong formats, accepts IDs (P89D-6)', () => {
    expect(idProblem('tiktok_pixel', '<script>!function (w, d, t) { w.TiktokAnalyticsObject')).toMatch(/This looks like code\. Paste only the Pixel ID/);
    expect(idProblem('meta_pixel', "fbq('init', '1284')")).toMatch(/looks like code/);
    expect(idProblem('ga4', 'UA-1234')).toMatch(/start with G-/);
    expect(idProblem('ga4', 'g-7k2qx9m4lp')).toBeNull();
    expect(normalizeId('ga4', ' g-7k2qx9m4lp ')).toBe('G-7K2QX9M4LP');
    expect(idProblem('tiktok_pixel', 'CQ8H2JRC77U0B1M3N4K0')).toBeNull();
    expect(idProblem('meta_pixel', '')).toMatch(/Enter your Pixel ID/);
    expect(idProblem('gtm_server', 'https://www.googletagmanager.com/gtm.js?id=GTM-1')).toMatch(/web container/);
    expect(testCodeProblem('TEST12345')).toBeNull();
    expect(testCodeProblem('TEST 1')).toMatch(/4–32 letters/);
  });

  it('GTM tagging URL rules (P89D-17) and the four check rows', () => {
    expect(taggingUrlProblem('http://sgtm.shop.com')).toBe('Use an https:// address.');
    expect(taggingUrlProblem('https://www.googletagmanager.com/gtm.js?id=GTM-ABC')).toMatch(/This is a web container \(gtm\.js\)/);
    expect(taggingUrlProblem('https://10.0.0.1')).toMatch(/not an IP address/);
    expect(taggingUrlProblem('https://sgtm.local')).toMatch(/public domain/);
    expect(taggingUrlProblem('https://sgtm.shop.com:8443')).toMatch(/443/);
    expect(taggingUrlProblem('https://sgtm.mugdhofashion.com')).toBeNull();
    expect(taggingUrlChecks('https://www.googletagmanager.com/gtm.js').map((c) => c.state)).toEqual(['ok', 'fail', 'fail', 'skipped']);
  });

  it('masks hints to the last 4, never more', () => {
    expect(maskedHint('••••3fQa')).toBe('••••3fQa');
    expect(maskedHint('abcd1234')).toBe('••••1234');
    expect(maskedHint(undefined)).toBeNull();
  });

  it('event statuses, error lines, tab parsing and error copy', () => {
    expect(eventStatusMeta(logEntry({ status: 'retrying', attempts: 2 })).label).toBe('Retrying · 2 of 5');
    expect(eventStatusMeta(logEntry({ deduplicated: true })).label).toBe('Deduplicated');
    expect(eventErrorText(logEntry({ status: 'failed', error_code: 'auth', http_status: 401 }))).toMatch(/Replace the token/);
    expect(eventErrorText(logEntry({ status: 'skipped', skip_reason: 'no_consent' }))).toMatch(/declined cookies/);
    expect(parseTab('nope', PIXEL_TABS)).toBe('overview');
    expect(parseTab('test', PIXEL_TABS)).toBe('test');
    expect(attentionText({ reason: 'items_with_issues', count: 4, since: '' }, 'google_merchant')).toMatch(/4 products have issues/);
    expect(integrationErrorText(new ApiError(422, 'website_claim_failed', 'x', { step: 'verify' }), 'google_merchant')).toMatch(/couldn’t verify/);
    expect(integrationErrorText(new ApiError(422, 'integration_code_pasted', 'x', { field: 'pixel_id' }), 'meta_pixel')).toBe('This looks like code. Paste only the Pixel ID.');
  });
});

describe('PHASE-8-9D Integrations list (P89D-50)', () => {
  it('owner sees Marketing & tracking and Sales channels groups, chips and an Upgrade badge', async () => {
    signedIn('owner', listRoutes());
    renderApp(<AppRoutes />, { route: '/integrations' });
    const tracking = await screen.findByRole('region', { name: 'Marketing & tracking' }, SLOW);
    const ga4 = await within(tracking).findByRole('article', { name: 'Google Analytics 4' });
    expect(within(ga4).getByText('Connected')).toBeInTheDocument();
    expect(within(ga4).getByText('G-7K2QX9M4LP · purchases from server')).toBeInTheDocument();
    expect(within(ga4).getByRole('link', { name: 'Manage Google Analytics 4' })).toHaveAttribute('href', '/integrations/ga4');
    expect(within(tracking).getByRole('link', { name: 'Connect TikTok Pixel + Events API' })).toHaveAttribute('href', '/integrations/tiktok');
    const gtm = within(tracking).getByRole('article', { name: 'Google Tag Manager' });
    expect(within(gtm).getByText('Upgrade · Growth')).toBeInTheDocument();
    const channels = screen.getByRole('region', { name: 'Sales channels' });
    const gmc = within(channels).getByRole('article', { name: 'Google Merchant Center' });
    expect(within(gmc).getByText('Needs attention')).toBeInTheDocument();
    expect(within(gmc).getByText(/4 products have issues/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connected · 3' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sales channels' }));
    expect(screen.queryByRole('region', { name: 'Marketing & tracking' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Sales channels' })).toBeInTheDocument();
  });

  it('staff see no tracking or feeds groups and never call the list', async () => {
    const fetchMock = signedIn('staff', listRoutes());
    renderApp(<AppRoutes />, { route: '/integrations' });
    await screen.findByRole('region', { name: 'Payments' }, SLOW);
    expect(screen.queryByRole('region', { name: 'Marketing & tracking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sales channels' })).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/stores/S1/integrations')).toHaveLength(0);
  });

  it('list error shows the error state with retry', async () => {
    signedIn('owner', { ...listRoutes(), 'GET /stores/S1/integrations': err(500, 'server_error') });
    renderApp(<AppRoutes />, { route: '/integrations?filter=tracking' });
    expect(await screen.findByText('We couldn’t load marketing & tracking', undefined, SLOW)).toBeInTheDocument();
  });
});

describe('PHASE-8-9D pixel connect (TikTok 2133:53731)', () => {
  it('pasted code is refused client-side; valid ID + token PUTs IDs and the token only', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/integrations/tiktok_pixel': ok(integration('tiktok_pixel')),
      'PUT /stores/S1/integrations/tiktok_pixel': ok(connected('tiktok_pixel', { pixel_id: 'CQ8H2JRC77U0B1M3N4K0' }, { credentials_hint: { access_token: '••••9mTe' } })),
      'GET /stores/S1/integrations/tiktok_pixel/stats': ok(stats({ provider: 'tiktok_pixel' })),
    });
    renderApp(<AppRoutes />, { route: '/integrations/tiktok' });
    const form = await screen.findByRole('form', { name: 'Connect TikTok' }, SLOW);
    const id = within(form).getByLabelText('Pixel ID');
    await userEvent.type(id, '<script>!function (w, d, t) {{ w.Ti');
    await userEvent.type(within(form).getByLabelText('Events API access token'), 'tok_abcdefgh9mTe');
    await userEvent.click(within(form).getByRole('button', { name: 'Connect TikTok' }));
    expect(await within(form).findByText(/This looks like code\. Paste only the Pixel ID/)).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/integrations/tiktok_pixel', 'PUT')).toHaveLength(0);

    await userEvent.clear(id);
    await userEvent.type(id, 'cq8h2jrc77u0b1m3n4k0');
    await userEvent.type(within(form).getByLabelText('Test event code'), 'TEST48211');
    await userEvent.click(within(form).getByRole('button', { name: 'Connect TikTok' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/tiktok_pixel', 'PUT')).toHaveLength(1));
    const body = bodyOf(byMethod(fetchMock, '/stores/S1/integrations/tiktok_pixel', 'PUT')[0]!);
    expect(body.settings.pixel_id).toBe('CQ8H2JRC77U0B1M3N4K0');
    expect(body.settings.test_event_code).toBe('TEST48211');
    expect(body.credentials).toEqual({ access_token: 'tok_abcdefgh9mTe' });
    expect(body.revision).toBeUndefined();
    expect(await screen.findByRole('tab', { name: 'Overview' }, SLOW)).toBeInTheDocument();
  });

  it('API 422 integration_code_pasted lands on the field it names', async () => {
    signedIn('owner', {
      'GET /stores/S1/integrations/meta_pixel': ok(integration('meta_pixel')),
      'PUT /stores/S1/integrations/meta_pixel': err(422, 'integration_code_pasted', { field: 'pixel_id' }),
    });
    renderApp(<AppRoutes />, { route: '/integrations/meta-pixel' });
    const form = await screen.findByRole('form', { name: 'Connect Meta' }, SLOW);
    await userEvent.type(within(form).getByLabelText('Pixel ID'), '128455670912334');
    await userEvent.type(within(form).getByLabelText('Conversions API access token'), 'EAAB12345678');
    await userEvent.click(within(form).getByRole('button', { name: 'Connect Meta' }));
    expect(await within(form).findByText('This looks like code. Paste only the Pixel ID.')).toBeInTheDocument();
  });
});

describe('PHASE-8-9D pixel detail (GA4 2132:53511, Meta 2139:56806 / 2134:64916 / 2139:57369)', () => {
  it('secret is write-only: masked last 4 + Replace, never Show; Replace PUTs the new secret with the revision', async () => {
    const fetchMock = signedIn('owner', pixelRoutes(ga4Connected(), 'ga4', { 'PUT /stores/S1/integrations/ga4': ok(ga4Connected()), 'POST /stores/S1/integrations/ga4/verify': ok(check()) }));
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    expect(await screen.findByLabelText('Measurement Protocol API secret ending 3fQa', undefined, SLOW)).toHaveTextContent('••••••••••3fQa');
    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Ecommerce events · last 7 days' })).toHaveTextContent('18,420');
    await userEvent.click(screen.getByRole('button', { name: 'Replace Measurement Protocol API secret' }));
    const replace = screen.getByRole('form', { name: 'Replace Measurement Protocol API secret' });
    await userEvent.type(within(replace).getByLabelText('New measurement Protocol API secret'), 'newsecret9XyZ');
    await userEvent.click(within(replace).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/ga4', 'PUT')).toHaveLength(1));
    const body = bodyOf(byMethod(fetchMock, '/stores/S1/integrations/ga4', 'PUT')[0]!);
    expect(body).toMatchObject({ credentials: { api_secret: 'newsecret9XyZ' }, revision: 3 });
    expect(body.settings.measurement_id).toBe('G-7K2QX9M4LP');

    await userEvent.click(screen.getAllByRole('button', { name: 'Run check' })[0]!);
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('API secret accepted')).toBeInTheDocument();
  });

  it('Events tab: log rows with error detail; Errors chip filters by status', async () => {
    const fetchMock = signedIn(
      'owner',
      pixelRoutes(connected('meta_pixel', { pixel_id: '128455670912334' }), 'meta_pixel', {
        'GET /stores/S1/integrations/meta_pixel/events': ok([logEntry(), logEntry({ id: 'E2', event_id: 'purchase.O2', status: 'failed', error_code: 'auth', http_status: 401, order: { id: 'O2', number: 'GS-1042' } })], cursorMeta('c2')),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/meta-pixel?tab=events' });
    const log = await screen.findByRole('region', { name: 'Event log' }, SLOW);
    expect(await within(log).findByText('Order GS-1042')).toBeInTheDocument();
    expect(within(log).getByText(/The access token was rejected \(HTTP 401\)/)).toBeInTheDocument();
    await userEvent.click(within(log).getByRole('button', { name: 'Errors' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/integrations/meta_pixel/events').some((c) => searchOf(c).toString().includes('failed'))).toBe(true));
    await userEvent.click(within(log).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/integrations/meta_pixel/events').some((c) => searchOf(c).get('cursor') === 'c2')).toBe(true));
  });

  it('Test & verify: send test event shows the result; test mode opens the signed link and polls test events', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const fetchMock = signedIn(
      'owner',
      pixelRoutes(connected('meta_pixel', { pixel_id: '128455670912334', test_event_code: 'TEST48211' }), 'meta_pixel', {
        'POST /stores/S1/integrations/meta_pixel/test-event': ok({ event_id: 'test.01J', event: 'purchase', delivered: false, http_status: 400, error_code: 'rejected', provider_message: 'Invalid parameter', validation_messages: [] }),
        'POST /stores/S1/integrations/meta_pixel/test-mode': ok({ url: 'https://mugdho.storeplix.com/?sp_test=signed', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/meta-pixel?tab=test-events' });
    const setup = await screen.findByRole('region', { name: 'Test your setup' }, SLOW);
    await userEvent.click(within(setup).getByRole('button', { name: 'Send test event' }));
    expect(await within(setup).findByText(/Not accepted \(HTTP 400\)\. Invalid parameter/)).toBeInTheDocument();
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/meta_pixel/test-event', 'POST')[0]!)).toEqual({ event: 'purchase' });
    await userEvent.click(within(setup).getByRole('button', { name: 'Open shop in test mode ↗' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://mugdho.storeplix.com/?sp_test=signed', '_blank', 'noopener,noreferrer'));
    expect(await within(setup).findByText(/Test mode on · 30 min left/)).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/stores/S1/integrations/meta_pixel/events').every((c) => searchOf(c).get('filter[test]') === '1')).toBe(true);
  });

  it('Settings: toggles PATCH partial settings with the revision', async () => {
    const fetchMock = signedIn('owner', pixelRoutes(ga4Connected(), 'ga4', { 'PATCH /stores/S1/integrations/ga4': ok(ga4Connected()) }));
    renderApp(<AppRoutes />, { route: '/integrations/ga4?tab=settings' });
    const settings = await screen.findByRole('region', { name: 'Tracking settings' }, SLOW);
    await userEvent.click(within(settings).getByRole('switch', { name: 'Wait for cookie consent' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/ga4', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/ga4', 'PATCH')[0]!)).toEqual({ settings: { wait_for_consent: true }, revision: 3 });
    await userEvent.selectOptions(within(settings).getByLabelText('Send purchase when'), 'order_delivered');
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/ga4', 'PATCH')).toHaveLength(2));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/ga4', 'PATCH')[1]!).settings).toEqual({ purchase_trigger: 'order_delivered' });
  });

  it('Disconnect needs the typed DISCONNECT', async () => {
    const fetchMock = signedIn('owner', pixelRoutes(ga4Connected(), 'ga4', { 'POST /stores/S1/integrations/ga4/disconnect': ok(integration('ga4', { status: 'disconnected' })) }));
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }, SLOW));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Disconnect' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Type DISCONNECT to confirm'), 'disconnect');
    expect(confirm).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText('Type DISCONNECT to confirm'));
    await userEvent.type(within(dialog).getByLabelText('Type DISCONNECT to confirm'), 'DISCONNECT');
    await userEvent.click(confirm);
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/ga4/disconnect', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/ga4/disconnect', 'POST')[0]!)).toEqual({ confirm: 'DISCONNECT' });
  });

  it('marketing.manage without integrations.manage reads but cannot change; staff get no access', async () => {
    signedIn({ role: 'custom', permissions: ['marketing.manage'] }, pixelRoutes(ga4Connected()));
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    expect(await screen.findByLabelText('Measurement Protocol API secret ending 3fQa', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Replace/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send test event' })).not.toBeInTheDocument();
  });

  it('staff see the no-access state', async () => {
    signedIn('staff', pixelRoutes(ga4Connected()));
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    expect(await screen.findByText('You don’t have access to this page', undefined, SLOW)).toBeInTheDocument();
  });

  it('impersonation is read-only: no write controls', async () => {
    const imp = { id: 'I1', tenant_id: 'T1', tenant_name: 'Mugdho Fashion', owner_name: 'Rahim', reason: 'Support', expires_at: new Date(Date.now() + 3600_000).toISOString() };
    signedIn('owner', { ...pixelRoutes(ga4Connected()), 'GET /auth/me': jsonResponse(200, { data: user([{ ...tenantA, role: 'owner' }]), meta: { impersonation: imp } }) });
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    expect(await screen.findByLabelText('Measurement Protocol API secret ending 3fQa', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Replace/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('error state with retry when the integration fails to load', async () => {
    signedIn('owner', { 'GET /stores/S1/integrations/ga4': err(500, 'server_error') });
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    expect(await screen.findByText('We couldn’t load Google Analytics 4', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('PHASE-8-9D GTM server (2133:54292, 2140:58941)', () => {
  it('plan gate shows the upgrade state', async () => {
    signedIn('owner', { 'GET /stores/S1/integrations/gtm_server': ok(integration('gtm_server', { plan_required: 'server_side_tagging' })) });
    renderApp(<AppRoutes />, { route: '/integrations/gtm' });
    expect(await screen.findByText('Server-side tagging is on the Growth plan', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings/plan');
  });

  it('editing the tagging URL to a web container shows the error and keeps Check and save disabled', async () => {
    signedIn('owner', pixelRoutes(connected('gtm_server', { container_id: 'GTM-W8K3PZ5', tagging_server_url: 'https://sgtm.mugdhofashion.com', measurement_id: 'G-7K2QX9M4LP' }), 'gtm_server'));
    renderApp(<AppRoutes />, { route: '/integrations/gtm' });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit tagging server URL' }, SLOW));
    const input = screen.getByLabelText('Tagging server URL');
    await userEvent.clear(input);
    await userEvent.type(input, 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC');
    expect(screen.getByText(/This is a web container \(gtm\.js\)/)).toBeInTheDocument();
    expect(screen.getByText(/Not saved\. Events keep going to https:\/\/sgtm\.mugdhofashion\.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check and save' })).toBeDisabled();
  });
});

describe('PHASE-8-9D product feeds (2134:65506, 2134:66100, 2141:57154)', () => {
  it('OAuth start redirects the browser to the authorize URL', async () => {
    const assign = vi.spyOn(oauthNavigation, 'assign').mockImplementation(() => undefined);
    signedIn('owner', {
      'GET /stores/S1/integrations/meta_catalog': ok(integration('meta_catalog')),
      'POST /stores/S1/integrations/meta_catalog/oauth/start': ok({ authorize_url: 'https://www.facebook.com/v21.0/dialog/oauth?state=s', expires_at: '' }),
    });
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog' });
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Facebook' }, SLOW));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://www.facebook.com/v21.0/dialog/oauth?state=s'));
  });

  it('OAuth return with an error (provider value path) shows the reason', async () => {
    signedIn('owner', { 'GET /stores/S1/integrations/meta_catalog': ok(integration('meta_catalog')) });
    renderApp(<AppRoutes />, { route: '/integrations/meta_catalog?oauth=error&reason=denied' });
    expect(await screen.findByText('You cancelled the sign-in, so nothing was connected.', undefined, SLOW)).toBeInTheDocument();
  });

  it('setup_required: choose a catalog or create one', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/integrations/meta_catalog': ok(integration('meta_catalog', { status: 'setup_required' })),
      'GET /stores/S1/integrations/meta_catalog/accounts': ok([{ id: '1029384756102938', name: 'Mugdho Fashion Products', parent_name: 'Mugdho Fashion', item_count: 410 }]),
      'PUT /stores/S1/integrations/meta_catalog/account': ok(connected('meta_catalog', { catalog_id: '1029384756102938' })),
      'GET /stores/S1/integrations/meta_catalog/feed': ok(feedOverview()),
      'GET /stores/S1/integrations/meta_catalog/sync-runs': ok([run()], cursorMeta()),
    });
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog?oauth=success' });
    await userEvent.click(await screen.findByRole('radio', { name: /Mugdho Fashion Products/ }, SLOW));
    expect(screen.getByRole('radio', { name: /Create a new catalog/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect and start syncing' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/meta_catalog/account', 'PUT')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/meta_catalog/account', 'PUT')[0]!)).toEqual({ account_id: '1029384756102938' });
  });

  it('connected: counts, issues drawer with a product editor link, sync now 409', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/integrations/meta_catalog': ok(connected('meta_catalog', { catalog_id: '1029384756102938', business_name: 'Mugdho Fashion (Business Manager)' })),
      'GET /stores/S1/integrations/meta_catalog/feed': ok(feedOverview()),
      'GET /stores/S1/integrations/meta_catalog/sync-runs': ok([run(), run({ id: 'R2', status: 'failed', error_code: 'token_expired', trigger: 'schedule' })], cursorMeta()),
      'GET /stores/S1/integrations/meta_catalog/items': ok([item()], itemMeta()),
      'POST /stores/S1/integrations/meta_catalog/sync': err(409, 'feed_sync_in_progress'),
    });
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog' });
    const counts = await screen.findByRole('region', { name: 'Products in catalog' }, SLOW);
    expect(await within(counts).findByText('of 412 live')).toBeInTheDocument();
    expect(screen.getByText(/Catalog in sync · 404 of 412 products live/)).toBeInTheDocument();
    expect(await screen.findByText('Failed · token expired')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fix all' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Image is smaller than 500 × 500 px. Meta rejects small photos.')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Replace photo in product editor ↗' })).toHaveAttribute('href', '/products/P1');
    expect(searchOf(callsTo(fetchMock, '/stores/S1/integrations/meta_catalog/items')[0]!).toString()).toContain('has_issues');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('A sync is already running. It usually finishes in a few minutes.')).toBeInTheDocument();
  });

  it('Google: website not claimed → Verify and claim; store_not_live message', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/integrations/google_merchant': ok(connected('google_merchant', { merchant_id: '5284019372' }, { status: 'needs_attention', attention: [{ reason: 'website_not_claimed', count: null, since: '' }] })),
      'GET /stores/S1/integrations/google_merchant/feed': ok(feedOverview({ provider: 'google_merchant', clicks_30d: 1204 })),
      'GET /stores/S1/integrations/google_merchant/sync-runs': ok([], cursorMeta()),
      'POST /stores/S1/integrations/google_merchant/claim-website': err(409, 'store_not_live'),
    });
    renderApp(<AppRoutes />, { route: '/integrations/google-merchant' });
    expect(await screen.findByText(/Website not claimed yet/, undefined, SLOW)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Verify and claim website' }));
    expect(await screen.findByText('Publish your shop first — Google can’t verify a Coming soon page.')).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/integrations/google_merchant/claim-website', 'POST')).toHaveLength(1);
    expect(await screen.findByText('1,204')).toBeInTheDocument();
  });

  it('plan gate: product_feeds missing shows the upgrade state, no connect button', async () => {
    signedIn('owner', { 'GET /stores/S1/integrations/google_merchant': ok(integration('google_merchant', { plan_required: 'product_feeds' })) });
    renderApp(<AppRoutes />, { route: '/integrations/google-merchant' });
    expect(await screen.findByText('Product feeds is on the Starter plan', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
  });

  it('Products tab: chips filter by review status', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/integrations/meta_catalog': ok(connected('meta_catalog', { catalog_id: '1' })),
      'GET /stores/S1/integrations/meta_catalog/items': ok([item(), item({ id: 'CI2', review_status: 'approved', issues: [], product: { id: 'P2', name: 'Kids Frock Set', slug: 'kids' } })], itemMeta()),
    });
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog?tab=products' });
    expect(await screen.findByRole('link', { name: 'Kids Frock Set' }, SLOW)).toHaveAttribute('href', '/products/P2');
    await userEvent.click(screen.getByRole('button', { name: 'Approved · 404' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/integrations/meta_catalog/items').some((c) => searchOf(c).toString().includes('approved'))).toBe(true));
  });
});

// ---------- Completion pass: tabs per §8 / Q365, loading and empty states, GTM setup, feed read-only and dismiss ----------

const pending = () => new Promise<Response>(() => undefined) as unknown as Response;

describe('PHASE-8-9D pixel tabs (§8, Q365) and states', () => {
  it('tabs are Overview · Event log · Test & verify; ?tab=settings lands on Overview with the settings folded in', async () => {
    signedIn('owner', pixelRoutes(connected('meta_pixel', { pixel_id: '128455670912334' }, { credentials_hint: { access_token: '••••Xk7P' } }), 'meta_pixel'));
    renderApp(<AppRoutes />, { route: '/integrations/meta-pixel?tab=settings' });
    const tabs = await screen.findAllByRole('tab', undefined, SLOW);
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Event log', 'Test & verify']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Tracking settings' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Change Pixel ID' })).toBeInTheDocument();
    expect(screen.getByLabelText('Conversions API access token ending Xk7P')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Send browser events from our server too' })).toBeChecked();
  });

  it('changing the ID PUTs settings with the revision and never sends credentials; pasted code is refused first', async () => {
    const fetchMock = signedIn('owner', pixelRoutes(ga4Connected(), 'ga4', { 'PUT /stores/S1/integrations/ga4': ok(ga4Connected()) }));
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    const form = await screen.findByRole('form', { name: 'Change Measurement ID' }, SLOW);
    const input = within(form).getByLabelText('Measurement ID');
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "gtag('config', 'G-1')");
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/This looks like code\. Paste only the Measurement ID/)).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/integrations/ga4', 'PUT')).toHaveLength(0);
    await userEvent.clear(input);
    await userEvent.type(input, 'g-9zz8yy7xx6');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/ga4', 'PUT')).toHaveLength(1));
    const body = bodyOf(byMethod(fetchMock, '/stores/S1/integrations/ga4', 'PUT')[0]!);
    expect(body.settings.measurement_id).toBe('G-9ZZ8YY7XX6');
    expect(body.revision).toBe(3);
    expect(body.credentials).toBeUndefined();
  });

  it('read-only members see the settings disabled and no ID form', async () => {
    signedIn({ role: 'custom', permissions: ['marketing.manage'] }, pixelRoutes(ga4Connected()));
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    const settings = await screen.findByRole('region', { name: 'Tracking settings' }, SLOW);
    expect(within(settings).getByRole('switch', { name: 'Wait for cookie consent' })).toBeDisabled();
    expect(screen.queryByRole('form', { name: 'Change Measurement ID' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run check' })).not.toBeInTheDocument();
  });

  it('connect: a rejected token lands on the token field', async () => {
    signedIn('owner', {
      'GET /stores/S1/integrations/ga4': ok(integration('ga4')),
      'PUT /stores/S1/integrations/ga4': err(422, 'integration_credentials_invalid'),
    });
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    const form = await screen.findByRole('form', { name: 'Connect GA4' }, SLOW);
    expect(within(form).queryByLabelText('Test event code')).not.toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('Measurement ID'), 'G-7K2QX9M4LP');
    await userEvent.type(within(form).getByLabelText('Measurement Protocol API secret'), 'abc def');
    await userEvent.click(within(form).getByRole('button', { name: 'Connect GA4' }));
    expect(await within(form).findByText(/has no spaces/)).toBeInTheDocument();
    await userEvent.clear(within(form).getByLabelText('Measurement Protocol API secret'));
    await userEvent.type(within(form).getByLabelText('Measurement Protocol API secret'), 'abcdef3fQa');
    await userEvent.click(within(form).getByRole('button', { name: 'Connect GA4' }));
    expect(await within(form).findByText('The platform didn’t accept that token. Copy a new one and try again.')).toBeInTheDocument();
  });

  it('loading state while the integration loads', async () => {
    signedIn('owner', { 'GET /stores/S1/integrations/ga4': pending() });
    renderApp(<AppRoutes />, { route: '/integrations/ga4' });
    expect(await screen.findByLabelText('Loading integration', undefined, SLOW)).toHaveAttribute('aria-busy', 'true');
  });

  it('Event log: empty state; the 7/30 day switch asks for 30 days', async () => {
    const fetchMock = signedIn('owner', pixelRoutes(connected('tiktok_pixel', { pixel_id: 'CQ8H2JRC77U0B1M3N4K0' }), 'tiktok_pixel', { 'GET /stores/S1/integrations/tiktok_pixel/events': ok([], cursorMeta()) }));
    renderApp(<AppRoutes />, { route: '/integrations/tiktok?tab=events' });
    expect(await screen.findByText('No events yet', undefined, SLOW)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('tab', { name: '30 days' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/integrations/tiktok_pixel/stats').some((c) => searchOf(c).get('days') === '30')).toBe(true));
  });

  it('Test & verify without a test code points to Overview', async () => {
    signedIn('owner', pixelRoutes(connected('meta_pixel', { pixel_id: '128455670912334' }), 'meta_pixel'));
    renderApp(<AppRoutes />, { route: '/integrations/meta-pixel?tab=test-events' });
    const setup = await screen.findByRole('region', { name: 'Test your setup' }, SLOW);
    expect(within(setup).queryByRole('button', { name: 'Open shop in test mode ↗' })).not.toBeInTheDocument();
    await userEvent.click(within(setup).getByRole('button', { name: 'Overview tab' }));
    expect(await screen.findByRole('region', { name: 'Tracking settings' })).toBeInTheDocument();
  });

  it('list loading shows skeletons, not cards', async () => {
    signedIn('owner', { ...listRoutes(), 'GET /stores/S1/integrations': pending() });
    renderApp(<AppRoutes />, { route: '/integrations?filter=tracking' });
    const tracking = await screen.findByRole('region', { name: 'Marketing & tracking' }, SLOW);
    expect(within(tracking).queryByRole('article')).not.toBeInTheDocument();
  });
});

describe('PHASE-8-9D GTM server setup and forwarding settings', () => {
  const gtmLive = () => connected('gtm_server', { container_id: 'GTM-W8K3PZ5', tagging_server_url: 'https://sgtm.mugdhofashion.com', measurement_id: 'G-7K2QX9M4LP' });

  it('a web container is refused client-side; a server container PUTs; a blocked URL shows on the URL field', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/integrations/gtm_server': ok(integration('gtm_server')),
      'PUT /stores/S1/integrations/gtm_server': err(422, 'integration_endpoint_blocked'),
    });
    renderApp(<AppRoutes />, { route: '/integrations/gtm' });
    const form = await screen.findByRole('form', { name: 'Connect Google Tag Manager' }, SLOW);
    expect(screen.getByRole('region', { name: 'Web containers aren’t supported' })).toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('Server container ID'), 'GTM-W8K3PZ5');
    await userEvent.type(within(form).getByLabelText('Tagging server URL'), 'https://www.googletagmanager.com/gtm.js?id=GTM-W8K3PZ5');
    await userEvent.type(within(form).getByLabelText('Events are sent as (GA4 Measurement ID)'), 'G-7K2QX9M4LP');
    await userEvent.click(within(form).getByRole('button', { name: 'Check and connect' }));
    expect(await within(form).findByText(/This is a web container \(gtm\.js\)/)).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/integrations/gtm_server', 'PUT')).toHaveLength(0);

    await userEvent.clear(within(form).getByLabelText('Tagging server URL'));
    await userEvent.type(within(form).getByLabelText('Tagging server URL'), 'https://sgtm.mugdhofashion.com');
    await userEvent.click(within(form).getByRole('button', { name: 'Check and connect' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/gtm_server', 'PUT')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/gtm_server', 'PUT')[0]!).settings).toMatchObject({ container_id: 'GTM-W8K3PZ5', tagging_server_url: 'https://sgtm.mugdhofashion.com', measurement_id: 'G-7K2QX9M4LP' });
    expect(await within(form).findByText(/We can’t send to that address/)).toBeInTheDocument();
  });

  it('forwarding settings: unticking an event PATCHes the remaining events', async () => {
    const fetchMock = signedIn('owner', pixelRoutes(gtmLive(), 'gtm_server', { 'PATCH /stores/S1/integrations/gtm_server': ok(gtmLive()) }));
    renderApp(<AppRoutes />, { route: '/integrations/gtm?tab=settings' });
    const panel = await screen.findByRole('region', { name: 'Forwarding settings' }, SLOW);
    await userEvent.click(within(panel).getByRole('checkbox', { name: /^refund/ }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/gtm_server', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/gtm_server', 'PATCH')[0]!)).toEqual({ settings: { events: ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'] }, revision: 3 });
  });

  it('downgraded while connected: paused banner, reads stay', async () => {
    signedIn('owner', pixelRoutes({ ...gtmLive(), status: 'needs_attention', plan_required: 'server_side_tagging', attention: [{ reason: 'plan_required', count: null, since: '' }] }, 'gtm_server'));
    renderApp(<AppRoutes />, { route: '/integrations/gtm' });
    expect(await screen.findByText(/Paused — Server-side tagging isn’t in your plan any more/, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Server container' })).toBeInTheDocument();
  });
});

describe('PHASE-8-9D product feeds: states, read-only, dismiss, disconnect', () => {
  const catalogLive = () => connected('meta_catalog', { catalog_id: '1029384756102938' });
  const feedRoutes = (row = catalogLive(), extra: Record<string, Response> = {}) => ({
    'GET /stores/S1/integrations/meta_catalog': ok(row),
    'GET /stores/S1/integrations/meta_catalog/feed': ok(feedOverview()),
    'GET /stores/S1/integrations/meta_catalog/sync-runs': ok([run()], cursorMeta()),
    ...extra,
  });

  it('OAuth error banner can be dismissed', async () => {
    signedIn('owner', { 'GET /stores/S1/integrations/meta_catalog': ok(integration('meta_catalog')) });
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog?oauth=error&reason=missing_permission' });
    expect(await screen.findByText(/Some permissions were not granted/, undefined, SLOW)).toBeInTheDocument();
    await userEvent.click(within(screen.getByText(/Some permissions were not granted/).closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/Some permissions were not granted/)).not.toBeInTheDocument());
  });

  it('read-only member: no Connect, Sync now or Disconnect', async () => {
    signedIn({ role: 'custom', permissions: ['marketing.manage'] }, feedRoutes());
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog' });
    expect(await screen.findByRole('region', { name: 'Products in catalog' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(screen.getByText('Only owners and managers can connect or change integrations.')).toBeInTheDocument();
  });

  it('impersonation: no Sync now or Disconnect', async () => {
    const imp = { id: 'I1', tenant_id: 'T1', tenant_name: 'Mugdho Fashion', owner_name: 'Rahim', reason: 'Support', expires_at: new Date(Date.now() + 3600_000).toISOString() };
    signedIn('owner', { ...feedRoutes(), 'GET /auth/me': jsonResponse(200, { data: user([{ ...tenantA, role: 'owner' }]), meta: { impersonation: imp } }) });
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog' });
    expect(await screen.findByRole('region', { name: 'Products in catalog' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('Sync history empty state', async () => {
    signedIn('owner', feedRoutes(catalogLive(), { 'GET /stores/S1/integrations/meta_catalog/sync-runs': ok([], cursorMeta()) }));
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog?tab=history' });
    expect(await screen.findByText('No syncs yet. The first one starts right after you connect.', undefined, SLOW)).toBeInTheDocument();
  });

  it('Google: no Merchant Center account found', async () => {
    signedIn('owner', {
      'GET /stores/S1/integrations/google_merchant': ok(integration('google_merchant', { status: 'setup_required' })),
      'GET /stores/S1/integrations/google_merchant/accounts': ok([]),
    });
    renderApp(<AppRoutes />, { route: '/integrations/google-merchant' });
    expect(await screen.findByText(/No Merchant Center account found/, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect and start syncing' })).toBeDisabled();
  });

  it('feed settings: hide sold-out PATCHes with the revision', async () => {
    const fetchMock = signedIn('owner', feedRoutes(catalogLive(), { 'PATCH /stores/S1/integrations/meta_catalog': ok(catalogLive()), 'GET /stores/S1/categories': ok([]) }));
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog?tab=settings' });
    await userEvent.click(await screen.findByRole('switch', { name: 'Hide sold-out products' }, SLOW));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/meta_catalog', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/integrations/meta_catalog', 'PATCH')[0]!)).toEqual({ settings: { hide_sold_out: true }, revision: 3 });
  });

  it('disconnect a feed with the typed DISCONNECT', async () => {
    const fetchMock = signedIn('owner', feedRoutes(catalogLive(), { 'POST /stores/S1/integrations/meta_catalog/disconnect': ok(integration('meta_catalog', { status: 'disconnected' })) }));
    renderApp(<AppRoutes />, { route: '/integrations/meta-catalog' });
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }, SLOW));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Products already in your Meta catalog stay there/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Type DISCONNECT to confirm'), 'DISCONNECT');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/integrations/meta_catalog/disconnect', 'POST')).toHaveLength(1));
  });
});
