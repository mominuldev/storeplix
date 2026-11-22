import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { callsTo, mockApi, renderApp } from '../test/utils';
import { ForgotPasswordPage } from './ForgotPasswordPage';

describe('ForgotPasswordPage (L3)', () => {
  it('validates the email before calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderApp(<ForgotPasswordPage />, { route: '/forgot-password' });
    await userEvent.click(screen.getByRole('tab', { name: 'Email link' }));
    await userEvent.type(screen.getByLabelText('Email'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/auth/forgot-password')).toHaveLength(0);
  });

  it('posts the email and confirms without revealing whether the account exists', async () => {
    const api = mockApi({ 'POST /auth/forgot-password': new Response(null, { status: 202 }) });
    renderApp(<ForgotPasswordPage />, { route: '/forgot-password' });
    await userEvent.click(screen.getByRole('tab', { name: 'Email link' }));
    await userEvent.type(screen.getByLabelText('Email'), 'rahim@shop.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText(/If an account exists for rahim@shop.com/)).toBeInTheDocument();
    expect(callsTo(api, '/auth/forgot-password')[0]![1]!.body).toBe(JSON.stringify({ email: 'rahim@shop.com' }));
  });
});
