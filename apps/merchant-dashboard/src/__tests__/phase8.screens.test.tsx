import { ApiError } from '@storeplix/api-client';
import { useMutation } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { ApiErrorWatcher, READ_ONLY_MESSAGE } from '../impersonation/ApiErrorWatcher';
import { formatCountdown } from '../impersonation/hooks';
import { ticketFromHash } from '../impersonation/ticket';
import { impersonation } from '../impersonation/store';
import { suspension } from '../impersonation/suspension';
import { PageHeader } from '../layout/PageHeader';
import { auditActorName } from '../lib/audit';
import { session } from '../lib/session';
import { Toaster } from '../online-store/components/Toast';
import { callsTo, jsonResponse, mockApi, okHealth, renderApp, signedIn, store, user } from '../test/utils';

const TICKET = 'abcdefghijklmnop0123456789_-XYZ';
const owner = { id: 'T1', name: 'Mugdho Fashion', role: 'owner' as const };
const imp = (expiresInMs = 14 * 60_000 + 30_000) => ({
  id: 'IMP1',
  tenant_id: 'T1',
  tenant_name: 'Mugdho Fashion',
  owner_name: 'Rahim',
  reason: 'Support ticket T-2041',
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
});
const staffUser = () => ({ ...user([owner]), id: 'P1', name: 'Nadia (Store Plix)', email: 'nadia@storeplix.com' });

/** Impersonation session already running (cookie simulated by the signed-in flag). */
function impersonating(meta = imp(), routes: Parameters<typeof mockApi>[0] = {}) {
  session.start({ expires_at: meta.expires_at });
  return mockApi({
    'GET /auth/me': jsonResponse(200, { data: staffUser(), meta: { session_expires_at: meta.expires_at, impersonation: meta } }),
    'GET /stores': jsonResponse(200, { data: [store()] }),
    'GET /health': okHealth(),
    ...routes,
  });
}

beforeEach(() => {
  impersonation.reset();
  suspension.reset();
});

describe('/impersonate (contract §7.2)', () => {
  it('reads the ticket from the hash, clears it, starts the session and opens the banner on /', async () => {
    const meta = imp();
    const replace = vi.spyOn(window.history, 'replaceState');
    window.history.pushState(null, '', `/impersonate#ticket=${TICKET}`);
    const fetchMock = mockApi({
      'POST /auth/impersonation': () => {
        session.start({ expires_at: meta.expires_at });
        return jsonResponse(200, { data: { user: staffUser(), impersonation: meta, session_expires_at: meta.expires_at } });
      },
      'GET /auth/me': jsonResponse(200, { data: staffUser(), meta: { session_expires_at: meta.expires_at, impersonation: meta } }),
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': okHealth(),
    });
    renderApp(<AppRoutes />, { route: `/impersonate#ticket=${TICKET}` });

    const banner = await screen.findByRole('region', { name: 'Support session' });
    expect(banner).toHaveTextContent('You are viewing Mugdho Fashion as Rahim (owner)');
    expect(banner).toHaveTextContent('Reason: Support ticket T-2041');
    expect(banner).toHaveTextContent('Read-only');
    expect(window.location.hash).toBe('');
    expect(replace).toHaveBeenCalled();
    const post = callsTo(fetchMock, '/auth/impersonation')[0]!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ ticket: TICKET });
    expect(session.getTenantId()).toBe('T1');
    // Dashboard of the impersonated shop.
    expect(await screen.findByRole('heading', { name: /, Nadia/ })).toBeInTheDocument();
    replace.mockRestore();
  });

  it('shows the expired-link screen for a used or expired ticket', async () => {
    mockApi({ 'POST /auth/impersonation': jsonResponse(404, { error: { code: 'not_found', message: 'Not found.' } }) });
    renderApp(<AppRoutes />, { route: `/impersonate#ticket=${TICKET}` });
    expect(await screen.findByText('This link has expired. Start again from Store Plix admin.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Store Plix admin' })).toHaveAttribute('href', 'http://localhost:5174');
  });

  it('never calls the API without a well-formed ticket', async () => {
    const fetchMock = mockApi({});
    renderApp(<AppRoutes />, { route: '/impersonate#ticket=<script>' });
    expect(await screen.findByText('This link has expired. Start again from Store Plix admin.')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/auth/impersonation')).toHaveLength(0);
    expect(ticketFromHash('#ticket=short')).toBeNull();
    expect(ticketFromHash(`#ticket=${TICKET}`)).toBe(TICKET);
  });
});

describe('impersonation frame', () => {
  it('counts down mm:ss from expires_at', async () => {
    impersonating(imp(65_000));
    renderApp(<AppRoutes />, { route: '/' });
    const timer = await screen.findByRole('timer', { name: 'Time left' });
    expect(timer.textContent).toMatch(/^01:0[0-5] left$/);
    expect(formatCountdown(14 * 60_000 + 59_001)).toBe('15:00');
    expect(formatCountdown(0)).toBe('00:00');
  });

  it('shows "Impersonation ended" (not the login page) when the countdown reaches 0', async () => {
    impersonating(imp(1_200));
    renderApp(<AppRoutes />, { route: '/' });
    await screen.findByRole('region', { name: 'Support session' });
    expect(await screen.findByRole('heading', { name: 'Impersonation ended' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Store Plix admin' })).toHaveAttribute('href', 'http://localhost:5174');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(session.peekNotice()).toBeNull();
  });

  it('a 401 impersonation_ended ends the session on the ended screen', async () => {
    impersonating(imp(), {
      'GET /stores': jsonResponse(401, { error: { code: 'impersonation_ended', message: 'This support session has ended.' } }),
    });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByRole('heading', { name: 'Impersonation ended' })).toBeInTheDocument();
    expect(session.isSignedIn()).toBe(false);
  });

  it('Exit impersonation sends DELETE /auth/impersonation and shows the ended screen', async () => {
    const fetchMock = impersonating(imp(), { 'DELETE /auth/impersonation': () => new Response(null, { status: 204 }) });
    renderApp(<AppRoutes />, { route: '/' });
    await userEvent.click(await screen.findByRole('button', { name: 'Exit impersonation' }));
    expect(await screen.findByRole('heading', { name: 'Impersonation ended' })).toBeInTheDocument();
    expect(callsTo(fetchMock, '/auth/impersonation').map(([, init]) => init!.method)).toEqual(['DELETE']);
  });

  it('disables page-header primary actions while read-only', async () => {
    impersonating();
    renderApp(
      <>
        <AppRoutes />
        <PageHeader title="Products" actions={<button type="button">Add product</button>} />
      </>,
      { route: '/' },
    );
    await screen.findByRole('region', { name: 'Support session' });
    const header = screen.getByRole('heading', { name: 'Products' }).parentElement!.parentElement!;
    const wrapper = header.querySelector('[data-read-only]');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('inert');
  });
});

function WriteButton({ error }: { error: Error }) {
  const m = useMutation({
    mutationFn: async () => {
      throw error;
    },
  });
  return (
    <button type="button" onClick={() => m.mutate()}>
      Save
    </button>
  );
}

describe('global API error handling', () => {
  it('toasts once for 403 impersonation_read_only on any mutation', async () => {
    mockApi({});
    renderApp(
      <>
        <Toaster />
        <ApiErrorWatcher />
        <WriteButton error={new ApiError(403, 'impersonation_read_only', 'Read-only.')} />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(READ_ONLY_MESSAGE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => undefined);
    expect(screen.getAllByText(READ_ONLY_MESSAGE)).toHaveLength(1);
  });

  it('does not toast for other errors', async () => {
    mockApi({});
    renderApp(
      <>
        <Toaster />
        <ApiErrorWatcher />
        <WriteButton error={new ApiError(403, 'forbidden', 'Nope.')} />
      </>,
    );
    // Toasts are app-global and may still show from the previous case; only count new ones.
    const before = screen.queryAllByText(READ_ONLY_MESSAGE).length;
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => undefined);
    expect(screen.queryAllByText(READ_ONLY_MESSAGE)).toHaveLength(before);
  });

  it('shows the suspended screen for 403 tenant_suspended, with Sign out', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores': jsonResponse(403, { error: { code: 'tenant_suspended', message: 'This shop is suspended.' } }),
      'POST /auth/logout': () => new Response(null, { status: 204 }),
    });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByRole('heading', { name: 'Your shop is suspended' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact Store Plix support' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(callsTo(fetchMock, '/auth/logout')).toHaveLength(1));
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
  });
});

describe('activity log actor (S81)', () => {
  it('shows platform actors as "Store Plix support"', () => {
    expect(auditActorName({ actor: { type: 'platform_user', id: null, name: null } })).toBe('Store Plix support');
    expect(auditActorName({ actor: { type: 'user', id: 'U1', name: 'Rahim' } })).toBe('Rahim');
    expect(auditActorName({ actor: null })).toBe('Storeplix');
  });
});
