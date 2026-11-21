import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { session } from '../lib/session';
import { DevOtpHint } from '../otp/DevOtpHint';
import { future, jsonResponse, mockApi, okHealth, renderApp, store, tenantA, user } from '../test/utils';

const signedInUser = () => ({ data: user([tenantA]) });

describe('SMS sign-in (L2) and dev OTP hint', () => {
  it('sends a code, shows the dev hint, autofills and signs in', async () => {
    const api = mockApi({
      'POST /auth/otp/send': jsonResponse(202, { data: { expires_in: 300, resend_in: 60, dev_otp: '123456' } }),
      'POST /auth/login/otp': jsonResponse(200, { data: { token: 'otp-token', user: user(), expires_at: future() } }),
      'GET /auth/me': jsonResponse(200, signedInUser()),
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': okHealth(),
    });
    renderApp(<AppRoutes />, { route: '/login' });
    await userEvent.click(await screen.findByRole('tab', { name: 'SMS code' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), '01712-345678');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByText(/Dev mode — your code is/)).toHaveTextContent('123456');
    expect(screen.getByText(/Resend code in 1:00|Resend code in 0:5\d/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Autofill' }));
    expect(screen.getByLabelText('Verification code digit 6')).toHaveValue('6');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    await waitFor(() => expect(session.getToken()).toBe('otp-token'));
    const send = api.mock.calls.find(([u]) => String(u).endsWith('/auth/otp/send'))!;
    expect(JSON.parse(String(send[1]!.body))).toEqual({ phone: '8801712345678', purpose: 'login' });
    const login = api.mock.calls.find(([u]) => String(u).endsWith('/auth/login/otp'))!;
    expect(JSON.parse(String(login[1]!.body))).toEqual({ phone: '8801712345678', code: '123456' });
  });

  it('shows no dev hint when the API omits dev_otp', async () => {
    mockApi({ 'POST /auth/otp/send': jsonResponse(202, { data: { expires_in: 300, resend_in: 60 } }) });
    renderApp(<AppRoutes />, { route: '/login' });
    await userEvent.click(await screen.findByRole('tab', { name: 'SMS code' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), '01712345678');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByLabelText('Verification code digit 1')).toBeInTheDocument();
    expect(screen.queryByText(/Dev mode/)).not.toBeInTheDocument();
  });

  it('DevOtpHint renders nothing outside a DEV build even with a code', () => {
    const { container } = render(<DevOtpHint code="123456" onAutofill={() => undefined} isDev={false} />);
    expect(container).toBeEmptyDOMElement();
    render(<DevOtpHint code="123456" onAutofill={() => undefined} isDev />);
    expect(screen.getByRole('note')).toHaveTextContent('Dev mode — your code is 123456');
  });

  it('shows the retry_after countdown on otp_rate_limited', async () => {
    mockApi({ 'POST /auth/otp/send': jsonResponse(429, { error: { code: 'otp_rate_limited', message: 'Too many', retry_after: 42 } }) });
    renderApp(<AppRoutes />, { route: '/login' });
    await userEvent.click(await screen.findByRole('tab', { name: 'SMS code' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), '01712345678');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Too many codes requested. Try again in 0:42.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send code in 0:4\d/ })).toBeDisabled();
  });

  it('maps a wrong code to a friendly error', async () => {
    mockApi({
      'POST /auth/otp/send': jsonResponse(202, { data: { expires_in: 300, resend_in: 60 } }),
      'POST /auth/login/otp': jsonResponse(422, { error: { code: 'invalid_otp', message: 'Invalid code.' } }),
    });
    renderApp(<AppRoutes />, { route: '/login' });
    await userEvent.click(await screen.findByRole('tab', { name: 'SMS code' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), '01712345678');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(await screen.findByLabelText('Verification code digit 1'), '999999');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText(/That code is wrong or has expired/)).toBeInTheDocument();
  });
});

describe('Verify phone (02) and banner', () => {
  it('auto-sends a code to an unverified user and verifies it', async () => {
    session.setAuth({ token: 'tok', expires_at: future() });
    let verified = false;
    const api = mockApi({
      'GET /auth/me': () => jsonResponse(200, { data: { ...user(), phone_verified_at: verified ? 'now' : null } }),
      'POST /auth/otp/send': jsonResponse(202, { data: { expires_in: 300, resend_in: 60 } }),
      'POST /auth/phone/verify': () => {
        verified = true;
        return jsonResponse(200, { data: { ...user(), phone_verified_at: 'now' } });
      },
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': okHealth(),
    });
    renderApp(<AppRoutes />, { route: '/verify-phone' });
    expect(await screen.findByText(/Sent by SMS to 01712-345678/)).toBeInTheDocument();
    await waitFor(() => expect(api.mock.calls.filter(([u]) => String(u).endsWith('/auth/otp/send'))).toHaveLength(1));
    await userEvent.type(screen.getByLabelText('Verification code digit 1'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify & continue' }));
    expect(await screen.findByRole('heading', { name: /, Rahim$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Verify your mobile number so you can/)).not.toBeInTheDocument();
  });

  it('nags unverified users on the dashboard', async () => {
    session.setAuth({ token: 'tok', expires_at: future() });
    mockApi({
      'GET /auth/me': jsonResponse(200, { data: { ...user(), phone_verified_at: null } }),
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': okHealth(),
    });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText(/Verify your mobile number so you can/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Verify now' })).toHaveAttribute('href', '/verify-phone');
  });
});

describe('Forgot password by SMS (L3)', () => {
  it('phone → code + new password → done', async () => {
    const api = mockApi({
      'POST /auth/otp/send': jsonResponse(202, { data: { expires_in: 300, resend_in: 60 } }),
      'POST /auth/reset-password/otp': jsonResponse(200, { data: { message: 'Your password has been reset.' } }),
    });
    renderApp(<AppRoutes />, { route: '/forgot-password' });
    await userEvent.type(await screen.findByLabelText('Mobile number'), '+8801712345678');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(await screen.findByLabelText('Verification code digit 1'), '123456');
    await userEvent.type(screen.getByLabelText('New password'), 'newpass123');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'newpass123');
    await userEvent.click(screen.getByRole('button', { name: 'Save password and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Password updated' })).toBeInTheDocument();
    const reset = api.mock.calls.find(([u]) => String(u).endsWith('/auth/reset-password/otp'))!;
    expect(JSON.parse(String(reset[1]!.body))).toEqual({ phone: '8801712345678', code: '123456', password: 'newpass123', password_confirmation: 'newpass123' });
  });
});
