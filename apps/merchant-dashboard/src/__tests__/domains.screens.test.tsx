import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { activeDomain, asStaff, domain, domainsResponse, platformDomain, record } from './domains.fixtures';

// Phase 6 §8 / §10 "Dashboard": Domains page states, records table, Connect dialog error mapping, Check now 429
// countdown, make-primary and remove confirms, plan-locked and limit states, staff read-only. API mocked per 1.7.0.

const SLOW = { timeout: 5000 };
const route = '/online-store/domains';
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);

afterEach(() => vi.unstubAllGlobals());

describe('Domains page', () => {
  it('lists addresses with status, primary and limit; focuses the connecting domain with its records', async () => {
    signedIn('owner', { 'GET /stores/S1/domains': domainsResponse([platformDomain(), domain(), activeDomain()], { limit: { used: 2, max: 2 }, can_add: false }) });
    renderApp(<AppRoutes />, { route });
    const list = (await screen.findByRole('heading', { name: 'All addresses' }, SLOW)).closest('section')!;
    const platform = within(list).getByRole('listitem', { name: 'mugdho.storeplix.com' });
    expect(within(platform).getByText('Primary')).toBeInTheDocument();
    expect(within(platform).getByText('Connected')).toBeInTheDocument();
    expect(within(platform).getByLabelText('Can’t be removed')).toBeInTheDocument();
    expect(within(list).getByRole('listitem', { name: 'shop.mugdho.com' })).toHaveTextContent('Waiting for DNS');
    expect(within(list).getByText('2 of 2 custom domains')).toBeInTheDocument();
    expect(screen.getByText('This page updates on its own while a domain is connecting.')).toBeInTheDocument();

    const card = screen.getByRole('region', { name: 'DNS records for shop.mugdho.com' });
    const txt = within(card).getByRole('row', { name: 'TXT record' });
    expect(within(txt).getByText('_storeplix-verify.shop')).toBeInTheDocument();
    expect(within(txt).getByText('sp-verify=abcdefgh')).toBeInTheDocument();
    expect(within(txt).getAllByText('Not found yet').length).toBeGreaterThan(0);
    expect(within(txt).getByRole('button', { name: 'Copy TXT value' })).toBeInTheDocument();
    expect(within(card).getByRole('row', { name: 'CNAME record' })).toHaveTextContent('customers.storeplix.test');
    expect(within(card).getByRole('alert')).toHaveTextContent('We can’t see the TXT record yet');
    expect(within(card).getByText('We’ll keep checking for 2 days 14 h.')).toBeInTheDocument();
    // 390 px: each record row carries its own Name/Value labels (shown below md), the header row is md-only.
    expect(within(txt).getByText('Name')).toHaveClass('md:hidden');
    expect(within(card).getAllByRole('columnheader')[0]!.parentElement).toHaveClass('hidden', 'md:grid');
    // FQDN toggle
    await userEvent.click(within(card).getByRole('button', { name: 'Show full names' }));
    expect(within(txt).getByText('_storeplix-verify.shop.mugdho.com')).toBeInTheDocument();
    // limit reached: Connect is disabled with the plan note
    expect(screen.getByRole('button', { name: 'Connect a domain' })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('Your plan allows 2 custom domains.');
    // no Buy CTA (2042:48250 out of scope)
    expect(screen.queryByRole('button', { name: /buy/i })).not.toBeInTheDocument();
  });

  it('shows mismatch values, the Cloudflare tip and the apex note', async () => {
    const d = domain({
      is_apex: true,
      failure_code: 'cname_mismatch',
      dns_records: [record('ownership', { status: 'ok' }), record('routing', { status: 'mismatch', found: ['104.21.1.1'] })],
    });
    signedIn('owner', { 'GET /stores/S1/domains': domainsResponse([platformDomain(), d]) });
    renderApp(<AppRoutes />, { route });
    const card = await screen.findByRole('region', { name: 'DNS records for shop.mugdho.com' }, SLOW);
    expect(within(card).getByText('We found: 104.21.1.1')).toBeInTheDocument();
    expect(within(card).getAllByText('Doesn’t match').length).toBeGreaterThan(0);
    expect(within(card).getByText(/Turn off the proxy/)).toBeInTheDocument();
    expect(within(card).getByText(/CNAME flattening or ALIAS/)).toBeInTheDocument();
  });

  it('empty state when only the platform address exists', async () => {
    signedIn('owner', { 'GET /stores/S1/domains': domainsResponse([platformDomain()], { limit: { used: 0, max: 2 } }) });
    renderApp(<AppRoutes />, { route });
    expect(await screen.findByRole('heading', { name: 'Connect your own domain' }, SLOW)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Connect a domain' })).toHaveLength(2);
  });

  it('error state with retry, then loads', async () => {
    let fail = true;
    signedIn('owner', { 'GET /stores/S1/domains': () => (fail ? jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) : domainsResponse([platformDomain()])) });
    renderApp(<AppRoutes />, { route });
    expect(await screen.findByText('We couldn’t load your domains. Check your connection and try again.', {}, SLOW)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Connect your own domain' })).toBeInTheDocument();
  });

  it('plan without the feature shows the upgrade card and no Connect CTA', async () => {
    signedIn('owner', { 'GET /stores/S1/domains': domainsResponse([platformDomain()], { feature_enabled: false, can_add: false, limit: { used: 0, max: 0 } }) });
    renderApp(<AppRoutes />, { route });
    const upgrade = await screen.findByRole('region', { name: 'Upgrade for your own domain' }, SLOW);
    expect(within(upgrade).getByRole('link', { name: /See plans/ })).toHaveAttribute('href', '/settings/plan');
    expect(screen.queryByRole('button', { name: 'Connect a domain' })).not.toBeInTheDocument();
  });

  it('a foreign or removed domain id shows not found', async () => {
    signedIn('owner', { 'GET /stores/S1/domains': domainsResponse([platformDomain()]) });
    renderApp(<AppRoutes />, { route: `${route}/DX` });
    expect(await screen.findByRole('heading', { name: 'Domain not found' }, SLOW)).toBeInTheDocument();
  });
});

describe('Connect dialog', () => {
  it('strips the URL, shows the apex hint and opens the new domain', async () => {
    const created = domain({ id: 'D9', hostname: 'acme.com', display_hostname: 'acme.com', is_apex: true });
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/domains': domainsResponse([platformDomain()]),
      'POST /stores/S1/domains': jsonResponse(201, { data: created }),
      'GET /stores/S1/domains/D9': jsonResponse(200, { data: created }),
    });
    renderApp(<AppRoutes />, { route });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Connect a domain' }, SLOW))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Connect a domain' });
    await userEvent.type(within(dialog).getByLabelText('Domain'), 'https://Acme.com/shop');
    expect(within(dialog).getByRole('note')).toHaveTextContent('www.acme.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/domains', 'POST')).toHaveLength(1));
    expect(JSON.parse(String(byMethod(fetchMock, '/stores/S1/domains', 'POST')[0]![1].body))).toEqual({ hostname: 'acme.com' });
    expect(await screen.findByText('Now add the two DNS records for acme.com.')).toBeInTheDocument();
  });

  it('validates client-side and maps server errors inline', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/domains': domainsResponse([platformDomain()]),
      'POST /stores/S1/domains': jsonResponse(422, { error: { code: 'domain_taken', message: 'Taken' } }),
    });
    renderApp(<AppRoutes />, { route });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Connect a domain' }, SLOW))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Connect a domain' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog).findByText('Enter the domain you want to connect.')).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/domains', 'POST')).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText('Domain'), 'shop.taken.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog).findByText(/already connected to a shop/)).toBeInTheDocument();
  });

  it('maps 402 plan_limit_reached to the app-wide upgrade dialog (Phase 7 §8.3, upgrade_plan hint)', async () => {
    signedIn('owner', {
      'GET /stores/S1/domains': domainsResponse([platformDomain()]),
      'POST /stores/S1/domains': jsonResponse(402, { error: { code: 'plan_limit_reached', message: 'Your plan allows 2 custom domains.', details: { custom_domains: ['x'], upgrade_plan: ['growth'] } } }),
    });
    renderApp(<AppRoutes />, { route });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Connect a domain' }, SLOW))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Connect a domain' });
    await userEvent.type(within(dialog).getByLabelText('Domain'), 'shop.acme.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    const upgrade = await screen.findByRole('dialog', { name: 'You’ve reached your plan’s limit' });
    expect(within(upgrade).getByText(/Your plan allows 2 custom domains\./)).toBeInTheDocument();
    expect(within(upgrade).getByRole('button', { name: 'Upgrade to Growth' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Connect a domain' })).not.toBeInTheDocument();
  });
});

describe('Actions', () => {
  it('Check now: 429 disables the button with a countdown', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/domains': domainsResponse([platformDomain(), domain()]),
      'POST /stores/S1/domains/D2/verify': jsonResponse(429, { error: { code: 'rate_limited', message: 'Slow down', retry_after: 42 } }),
    });
    renderApp(<AppRoutes />, { route });
    const card = await screen.findByRole('region', { name: 'DNS records for shop.mugdho.com' }, SLOW);
    await userEvent.click(within(card).getByRole('button', { name: 'Check now' }));
    const wait = await within(card).findByRole('button', { name: /Check again in 4[12] s/ });
    expect(wait).toBeDisabled();
    expect(byMethod(fetchMock, '/stores/S1/domains/D2/verify', 'POST')).toHaveLength(1);
  });

  it('Check now success updates the row', async () => {
    let row = domain();
    signedIn('owner', {
      'GET /stores/S1/domains': () => domainsResponse([platformDomain(), row]),
      'POST /stores/S1/domains/D2/verify': () => {
        row = domain({ status: 'ssl_provisioning', failure_code: null, dns_records: [record('ownership', { status: 'ok' }), record('routing')] });
        return jsonResponse(200, { data: row });
      },
    });
    renderApp(<AppRoutes />, { route });
    const card = await screen.findByRole('region', { name: 'DNS records for shop.mugdho.com' }, SLOW);
    await userEvent.click(within(card).getByRole('button', { name: 'Check now' }));
    expect(await within(card).findByText('Securing', { selector: 'span' })).toBeInTheDocument();
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Make primary confirms, posts, and refreshes the store', async () => {
    const promoted = [platformDomain({ is_primary: false }), activeDomain({ is_primary: true, can_remove: true })];
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/domains': domainsResponse([platformDomain(), activeDomain()]),
      'POST /stores/S1/domains/D3/primary': jsonResponse(200, { data: promoted }),
    });
    renderApp(<AppRoutes />, { route });
    await userEvent.click(await screen.findByRole('button', { name: 'Manage www.mugdho.com' }, SLOW));
    await userEvent.click(screen.getByRole('menuitem', { name: /Make primary/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Make www.mugdho.com your main address?' });
    expect(dialog).toHaveTextContent('Shoppers with an open cart on the old address will need to add items again.');
    const storeCalls = callsTo(fetchMock, '/stores').length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make primary' }));
    expect(await screen.findByText('www.mugdho.com is now your main address.')).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/domains/D3/primary', 'POST')).toHaveLength(1);
    await waitFor(() => expect(callsTo(fetchMock, '/stores').length).toBeGreaterThan(storeCalls));
  });

  it('Remove a primary domain requires typing the hostname and mentions the fallback', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/domains': domainsResponse([platformDomain({ is_primary: false }), activeDomain({ is_primary: true })]),
      'DELETE /stores/S1/domains/D3': new Response(null, { status: 204 }),
    });
    renderApp(<AppRoutes />, { route });
    await userEvent.click(await screen.findByRole('button', { name: 'Manage www.mugdho.com' }, SLOW));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove www.mugdho.com?' });
    expect(dialog).toHaveTextContent('Your shop will use mugdho.storeplix.com again.');
    const confirm = within(dialog).getByRole('button', { name: 'Remove domain' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Type www.mugdho.com to confirm'), 'www.mugdho.com');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/domains/D3', 'DELETE')).toHaveLength(1));
    expect(await screen.findByText('Removed. Your shop will use mugdho.storeplix.com again.')).toBeInTheDocument();
  });

  it('Remove a pending domain needs no typing', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/domains': domainsResponse([platformDomain(), domain()]),
      'DELETE /stores/S1/domains/D2': new Response(null, { status: 204 }),
    });
    renderApp(<AppRoutes />, { route });
    await userEvent.click(await screen.findByRole('button', { name: 'Manage shop.mugdho.com' }, SLOW));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove shop.mugdho.com?' });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove domain' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/domains/D2', 'DELETE')).toHaveLength(1));
  });

  it('staff: read-only, records visible, only View DNS records in the menu', async () => {
    signedIn('staff', { 'GET /stores/S1/domains': domainsResponse([asStaff(platformDomain()), asStaff(domain()), asStaff(activeDomain())], { can_add: false }) });
    renderApp(<AppRoutes />, { route });
    expect(await screen.findByText('View only.', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect a domain' })).not.toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'DNS records for shop.mugdho.com' });
    expect(within(card).queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument();
    expect(within(card).getByRole('row', { name: 'TXT record' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage mugdho.storeplix.com' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Manage www.mugdho.com' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['View DNS records']);
  });
});
