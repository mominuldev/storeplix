import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { session } from '../lib/session';
import { future, jsonResponse, mockApi, okHealth, renderApp, store, user } from '../test/utils';

const preview = (userExists: boolean) =>
  jsonResponse(200, {
    data: { tenant_name: 'Mugdho', store_name: 'Mugdho Fashion', email: 'tanvir@shop.com', role: 'staff', invited_by_name: 'Rafiqul Alam', expires_at: future(), user_exists: userExists },
  });

describe('Invitation accept (/invite)', () => {
  it('lets a new user set a password, accept and open the shop', async () => {
    const tenant = { id: 'T1', name: 'Mugdho', role: 'staff' as const };
    let body: unknown;
    mockApi({
      'GET /invitations/tok123': preview(false),
      'POST /invitations/tok123/accept': (init, headers) => {
        body = JSON.parse(String(init.body));
        expect(headers.Authorization).toBeUndefined();
        return jsonResponse(201, { data: { user: user([tenant]), expires_at: future() } });
      },
      'GET /auth/me': jsonResponse(200, { data: user([tenant]) }),
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': okHealth(),
    });
    renderApp(<AppRoutes />, { route: '/invite?token=tok123' });
    expect(await screen.findByRole('heading', { name: 'Join Mugdho Fashion' })).toBeInTheDocument();
    expect(screen.getByText(/Rafiqul Alam invited tanvir@shop.com as Staff/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your name'), 'Tanvir Hasan');
    await userEvent.type(screen.getByLabelText('Mobile number'), '01555112233');
    await userEvent.type(screen.getByLabelText('Password'), 'secret123');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'secret123');
    await userEvent.click(screen.getByRole('button', { name: 'Create account & join' }));
    await waitFor(() => expect(session.isSignedIn()).toBe(true));
    expect(body).toEqual({ name: 'Tanvir Hasan', phone: '8801555112233', password: 'secret123', password_confirmation: 'secret123' });
    expect(await screen.findByRole('heading', { name: /, Rahim$/ })).toBeInTheDocument();
  });

  it('asks an existing user to sign in first', async () => {
    mockApi({ 'GET /invitations/tok123': preview(true) });
    renderApp(<AppRoutes />, { route: '/invite?token=tok123' });
    expect(await screen.findByRole('button', { name: 'Sign in to accept' })).toBeInTheDocument();
  });

  it('accepts with the cookie session (CSRF header, no bearer) when already signed in', async () => {
    session.start({ expires_at: future() });
    const me = { ...user(), email: 'tanvir@shop.com' };
    let auth: string | undefined;
    let xsrf: string | undefined;
    mockApi({
      'GET /invitations/tok123': preview(true),
      'GET /auth/me': jsonResponse(200, { data: me }),
      'POST /invitations/tok123/accept': (_init, headers) => {
        auth = headers.Authorization;
        xsrf = headers['X-XSRF-TOKEN'];
        return jsonResponse(200, { data: { id: 'T1', name: 'Mugdho', role: 'staff' } });
      },
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': okHealth(),
    });
    renderApp(<AppRoutes />, { route: '/invite?token=tok123' });
    await userEvent.click(await screen.findByRole('button', { name: 'Join Mugdho Fashion' }));
    await waitFor(() => expect(xsrf).toBe('test-xsrf'));
    expect(auth).toBeUndefined();
    expect(await screen.findByRole('heading', { name: /, Rahim$/ })).toBeInTheDocument();
  });

  it('explains invalid or expired invitations', async () => {
    mockApi({ 'GET /invitations/bad': jsonResponse(404, { error: { code: 'invitation_invalid', message: 'Invalid' } }) });
    renderApp(<AppRoutes />, { route: '/invite?token=bad' });
    expect(await screen.findByText('This invitation isn’t valid anymore')).toBeInTheDocument();
    expect(screen.getByText(/expired or was cancelled/)).toBeInTheDocument();
  });
});

describe('Reset password (/reset-password)', () => {
  it('sets a new password from the email link', async () => {
    let body: unknown;
    mockApi({
      'POST /auth/reset-password': (init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse(200, { data: { message: 'Your password has been reset.' } });
      },
    });
    renderApp(<AppRoutes />, { route: '/reset-password?token=abc&email=rahim%40shop.com' });
    await userEvent.type(await screen.findByLabelText('New password'), 'newpass123');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'newpass123');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('heading', { name: 'Your password has been reset' })).toBeInTheDocument();
    expect(body).toEqual({ email: 'rahim@shop.com', token: 'abc', password: 'newpass123', password_confirmation: 'newpass123' });
  });

  it('handles invalid_reset_token', async () => {
    mockApi({ 'POST /auth/reset-password': jsonResponse(422, { error: { code: 'invalid_reset_token', message: 'Invalid' } }) });
    renderApp(<AppRoutes />, { route: '/reset-password?token=old&email=a%40b.co' });
    await userEvent.type(await screen.findByLabelText('New password'), 'newpass123');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'newpass123');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('heading', { name: 'This reset link has expired' })).toBeInTheDocument();
  });
});
