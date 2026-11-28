import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SmsPreferences } from '@storeplix/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { impersonation } from '../impersonation/store';
import { suspension } from '../impersonation/suspension';
import { session } from '../lib/session';
import { callsTo, jsonResponse, mockApi, okHealth, renderApp, signedIn, store, tenantA, user } from '../test/utils';

const CODE = 'Ab12Cd34Ef';
const SWITCH = 'Offers and news from Store Plix by SMS';

const prefs = (o: Partial<SmsPreferences> = {}): SmsPreferences => ({
  promotional: true,
  opted_out_at: null,
  source: null,
  phone_masked: '01•••-•••678',
  phone_verified: true,
  ...o,
});

beforeEach(() => {
  impersonation.reset();
  suspension.reset();
  session.clear();
});

describe('Account → Store Plix SMS (PHASE-8-9B §12)', () => {
  it('shows the verified masked phone and switches offers off', async () => {
    let body: unknown;
    const fetchMock = signedIn('owner', {
      'GET /account/sms-preferences': jsonResponse(200, { data: prefs() }),
      'PATCH /account/sms-preferences': (init, headers) => {
        body = JSON.parse(String(init.body));
        expect(headers['X-Tenant-Id']).toBeUndefined();
        return jsonResponse(200, { data: prefs({ promotional: false, opted_out_at: '2026-11-28T00:00:00Z', source: 'account' }) });
      },
    });
    renderApp(<AppRoutes />, { route: '/account' });
    const card = await screen.findByRole('region', { name: 'Store Plix SMS' });
    const toggle = await within(card).findByRole('switch', { name: SWITCH });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(within(card).getByText('Sent to 01•••-•••678')).toBeInTheDocument();
    expect(within(card).getByText('Sign-in codes, invoices and account messages are always sent.')).toBeInTheDocument();
    await userEvent.click(toggle);
    await waitFor(() => expect(within(card).getByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'false'));
    expect(body).toEqual({ promotional: false });
    expect(callsTo(fetchMock, '/account/sms-preferences')).toHaveLength(2);
  });

  it('asks to add and verify a phone when there is none', async () => {
    signedIn('owner', { 'GET /account/sms-preferences': jsonResponse(200, { data: prefs({ phone_masked: null, phone_verified: false }) }) });
    renderApp(<AppRoutes />, { route: '/account' });
    const card = await screen.findByRole('region', { name: 'Store Plix SMS' });
    expect(await within(card).findByText(/Add and verify a phone number to receive SMS/)).toBeInTheDocument();
  });

  it('shows an error with retry when loading fails, and an alert when saving fails', async () => {
    let fail = true;
    signedIn('owner', {
      'GET /account/sms-preferences': () => (fail ? jsonResponse(500, { error: { code: 'server_error', message: 'x' } }) : jsonResponse(200, { data: prefs() })),
      'PATCH /account/sms-preferences': jsonResponse(500, { error: { code: 'server_error', message: 'x' } }),
    });
    renderApp(<AppRoutes />, { route: '/account' });
    const card = await screen.findByRole('region', { name: 'Store Plix SMS' });
    expect(await within(card).findByText('Couldn’t load your SMS preferences.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    const toggle = await within(card).findByRole('switch', { name: SWITCH });
    await userEvent.click(toggle);
    expect(await within(card).findByText('Couldn’t save your SMS preference. Please try again.')).toBeInTheDocument();
    expect(within(card).getByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'true');
  });

  it('is view only in a support session and never loads the staff member’s preference', async () => {
    const meta = { id: 'IMP1', tenant_id: 'T1', tenant_name: 'Mugdho Fashion', owner_name: 'Rahim', reason: 'T-1', expires_at: new Date(Date.now() + 14 * 60_000).toISOString() };
    session.start({ expires_at: meta.expires_at });
    const fetchMock = mockApi({
      'GET /auth/me': jsonResponse(200, { data: { ...user([tenantA]), id: 'P1' }, meta: { session_expires_at: meta.expires_at, impersonation: meta } }),
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': okHealth(),
    });
    renderApp(<AppRoutes />, { route: '/account' });
    const card = await screen.findByRole('region', { name: 'Store Plix SMS' });
    expect(within(card).getByText('View only')).toBeInTheDocument();
    expect(within(card).queryByRole('switch')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/account/sms-preferences')).toHaveLength(0);
  });
});

describe('Public opt-out page /s/:code (PHASE-8-9B §7.6)', () => {
  const lookup = (status: 'subscribed' | 'opted_out') => jsonResponse(200, { data: { status, phone_masked: '01•••-•••678' } });

  it('works signed out: GET only shows the state, the button POSTs and shows the confirmation', async () => {
    let posted = 0;
    const fetchMock = mockApi({
      [`GET /platform-sms/opt-out/${CODE}`]: lookup('subscribed'),
      [`POST /platform-sms/opt-out/${CODE}`]: (_init, headers) => {
        posted++;
        expect(headers['X-Tenant-Id']).toBeUndefined();
        return lookup('opted_out');
      },
    });
    renderApp(<AppRoutes />, { route: `/s/${CODE}` });
    expect(await screen.findByRole('heading', { name: 'Stop Store Plix offers to 01•••-•••678?' })).toBeInTheDocument();
    expect(posted).toBe(0);
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    await userEvent.click(screen.getByRole('button', { name: 'Stop offers' }));
    expect(await screen.findByRole('heading', { name: 'You won’t get Store Plix offers by SMS any more' })).toBeInTheDocument();
    expect(screen.getByText(/You can turn them back on in your account/)).toBeInTheDocument();
    expect(posted).toBe(1);
    expect(callsTo(fetchMock, `/platform-sms/opt-out/${CODE}`)).toHaveLength(2);
  });

  it('shows the already-opted-out state without a button', async () => {
    mockApi({ [`GET /platform-sms/opt-out/${CODE}`]: lookup('opted_out') });
    renderApp(<AppRoutes />, { route: `/s/${CODE}` });
    expect(await screen.findByRole('heading', { name: 'You won’t get Store Plix offers by SMS any more' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop offers' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your account' })).toHaveAttribute('href', '/account');
  });

  it('shows "not valid" for an unknown (404) or malformed code', async () => {
    const fetchMock = mockApi({});
    renderApp(<AppRoutes />, { route: `/s/${CODE}` });
    expect(await screen.findByRole('heading', { name: 'This link is not valid' })).toBeInTheDocument();
    expect(callsTo(fetchMock, `/platform-sms/opt-out/${CODE}`)).toHaveLength(1);
  });

  it('does not call the API for a malformed code', async () => {
    const fetchMock = mockApi({});
    renderApp(<AppRoutes />, { route: '/s/bad!' });
    expect(await screen.findByRole('heading', { name: 'This link is not valid' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/platform-sms/'))).toBe(false);
  });

  it('shows the test-message state for the test code', async () => {
    const fetchMock = mockApi({});
    renderApp(<AppRoutes />, { route: '/s/test' });
    expect(await screen.findByRole('heading', { name: 'This was a test message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop offers' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/platform-sms/'))).toBe(false);
  });

  it('handles the rate limit on lookup (retry) and on stop', async () => {
    let limited = true;
    mockApi({
      [`GET /platform-sms/opt-out/${CODE}`]: () =>
        limited ? jsonResponse(429, { error: { code: 'rate_limited', message: 'Too many requests.' } }) : lookup('subscribed'),
      [`POST /platform-sms/opt-out/${CODE}`]: jsonResponse(429, { error: { code: 'rate_limited', message: 'Too many requests.' } }),
    });
    renderApp(<AppRoutes />, { route: `/s/${CODE}` });
    expect(await screen.findByRole('heading', { name: 'Too many tries' })).toBeInTheDocument();
    limited = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop offers' }));
    expect(await screen.findByText(/^Too many tries\. Please wait/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop offers' })).toBeInTheDocument();
  });
});
