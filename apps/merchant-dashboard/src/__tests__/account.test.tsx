import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { impersonation } from '../impersonation/store';
import { suspension } from '../impersonation/suspension';
import { session } from '../lib/session';
import { jsonResponse, mockApi, okHealth, renderApp, signedIn, store, tenantA, user } from '../test/utils';

const NOTICE = 'Account settings aren’t available in a support session.';

const imp = () => ({
  id: 'IMP1',
  tenant_id: 'T1',
  tenant_name: 'Mugdho Fashion',
  owner_name: 'Rahim',
  reason: 'Support ticket T-2041',
  expires_at: new Date(Date.now() + 14 * 60_000).toISOString(),
});

beforeEach(() => {
  impersonation.reset();
  suspension.reset();
});

describe('Account page (QA P8-QA-2)', () => {
  it('in a support session shows a read-only notice, not the staff member as owner or their profile forms', async () => {
    const meta = imp();
    session.start({ expires_at: meta.expires_at });
    // /auth/me is the platform staff user with owner-level access to the one impersonated shop (contract §3.2).
    mockApi({
      'GET /auth/me': jsonResponse(200, {
        data: { ...user([tenantA]), id: 'P1', name: 'Nadia (Store Plix)', email: 'nadia@storeplix.com' },
        meta: { session_expires_at: meta.expires_at, impersonation: meta },
      }),
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': okHealth(),
    });
    renderApp(<AppRoutes />, { route: '/account' });

    expect(await screen.findByRole('heading', { name: NOTICE })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your account', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Read-only support session for Mugdho Fashion.')).toBeInTheDocument();
    expect(screen.queryByText(/Owner of/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nadia \(Store Plix\)/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save profile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('outside a support session keeps the normal profile and security forms', async () => {
    signedIn('owner');
    renderApp(<AppRoutes />, { route: '/account' });

    expect(await screen.findByText('Rahim Ahmed · Owner of Mugdho Fashion — only you see this page.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toHaveValue('Rahim Ahmed');
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});
