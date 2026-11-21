import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../lib/session';
import { future, jsonResponse, mockApi, renderApp } from '../test/utils';
import { LoginPage } from './LoginPage';

describe('LoginPage', () => {
  it('shows validation errors and does not call the API for invalid input', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderApp(<LoginPage />, { route: '/login' });
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores token and expires_at in sessionStorage on success', async () => {
    const expires = future();
    mockApi({ 'POST /auth/login': jsonResponse(200, { data: { token: 'new-token', user: { id: '1' }, expires_at: expires } }) });
    renderApp(<LoginPage />, { route: '/login' });
    await userEvent.type(screen.getByLabelText('Email'), 'demo@storeplix.test');
    await userEvent.type(screen.getByLabelText('Password'), 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(session.getToken()).toBe('new-token'));
    expect(session.getExpiresAt()).toBe(expires);
  });

  it('shows a form error for wrong credentials', async () => {
    mockApi({ 'POST /auth/login': jsonResponse(401, { error: { code: 'invalid_credentials', message: 'Invalid credentials' } }) });
    renderApp(<LoginPage />, { route: '/login' });
    await userEvent.type(screen.getByLabelText('Email'), 'demo@storeplix.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });

});
