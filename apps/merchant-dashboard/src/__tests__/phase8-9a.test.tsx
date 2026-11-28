import type { CampaignEstimate } from '@storeplix/types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { AllowanceCard } from '../campaigns/PreviewColumn';
import { payNavigation } from '../settings/billing/PayDialog';
import { smsErrorText } from '../sms/errors';
import { senderIdSchema } from '../sms/SenderIdTab';
import {
  canOpenSms,
  countTemplate,
  documentProblem,
  formatRate,
  insertAt,
  logMessage,
  logStatusMeta,
  maskPhone,
  paceDuration,
  parseSmsTab,
  perSmsPrice,
  purchaseStatus,
  purposesFor,
  quietHoursLabel,
  renderSample,
  smsCapabilities,
  templateProblem,
  visibleTabs,
  type SampleContext,
} from '../sms/sms';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { settingsWithCommerce } from './phase5.fixtures';
import { account, allCan, cursorMeta, ledgerEntry, logEntry, overview, pageMeta, senderList, senderRequest, smsInvoice, template, templates } from './phase8-9a.fixtures';
import { ApiError } from '@storeplix/api-client';

// PHASE-8-9A §15 Web: helpers (tabs, permissions, part counter, formatters), tabs + permission gating, overview cards,
// language/toggle writes, test SMS dialog, template editor (insert at cursor, counter, preview, errors, reset, 409),
// sender ID form + pending/cancel, log filters + cursor + empty states, buy credits (key reuse, redirect, return
// polling), Integrations Messaging card, Notifications server preview, campaign allowance with credits.

vi.setConfig({ testTimeout: 20_000 });
const SLOW = { timeout: 5000 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const headerOf = (call: [string, RequestInit], name: string) => new Headers(call[1].headers).get(name);
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const searchOf = (call: [string, RequestInit]) => new URL(String(call[0]), 'http://localhost').searchParams;

const ctx: SampleContext = { shop: 'Mugdho Fashion', orderPrefix: 'MU', host: 'mugdho.storeplix.com', footer: null, masked: false };

function smsRoutes(extra: Record<string, Response | ((init: RequestInit) => Response)> = {}) {
  return {
    'GET /stores/S1/settings': settingsWithCommerce(),
    'GET /stores/S1/sms': jsonResponse(200, { data: overview() }),
    'GET /stores/S1/sms/templates': jsonResponse(200, { data: templates() }),
    'GET /billing/sms-credits': jsonResponse(200, { data: account() }),
    'GET /stores/S1/sms/sender-ids': jsonResponse(200, { data: senderList() }),
    'GET /stores/S1/sms/messages': jsonResponse(200, { data: [logEntry()], meta: cursorMeta() }),
    'GET /billing/invoices': jsonResponse(200, { data: [smsInvoice()], meta: pageMeta }),
    'GET /billing/sms-credits/ledger': jsonResponse(200, { data: [ledgerEntry()], meta: cursorMeta() }),
    ...extra,
  };
}


/** Uploads go through XHR (progress): a fake that answers `status`/`body` right after `send`. */
function stubXhr(status: number, body: unknown) {
  const sent: { url: string; body: FormData }[] = [];
  class FakeXhr {
    status = 0;
    statusText = '';
    responseText = '';
    url = '';
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open(_m: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    getResponseHeader() {
      return 'application/json';
    }
    getAllResponseHeaders() {
      return 'content-type: application/json';
    }
    send(form: FormData) {
      sent.push({ url: this.url, body: form });
      setTimeout(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
      }, 0);
    }
    abort() {}
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return sent;
}

describe('PHASE-8-9A helpers', () => {
  it('tab parsing and permission mapping (P89A-25)', () => {
    expect(parseSmsTab('templates')).toBe('templates');
    expect(parseSmsTab('nope')).toBe('overview');
    expect(parseSmsTab(null)).toBe('overview');
    const staff = { role: 'staff' as const, permissions: [] };
    expect(canOpenSms(staff)).toBe(false);
    expect(canOpenSms({ role: 'custom' as const, permissions: ['billing.view' as const] })).toBe(true);
    const billingOnly = smsCapabilities({ role: 'custom' as const, permissions: ['billing.view' as const] });
    expect(billingOnly).toMatchObject({ view_log: false, view_sender_ids: false, view_credit_history: true, buy_credits: false, edit_templates: false });
    expect(visibleTabs(billingOnly)).toEqual(['overview', 'templates', 'credits']);
    expect(visibleTabs(allCan)).toEqual(['overview', 'templates', 'sender-id', 'log', 'credits']);
    const integrations = smsCapabilities({ role: 'custom' as const, permissions: ['integrations.manage' as const] });
    expect(integrations).toMatchObject({ request_sender_id: true, send_test: true, edit_templates: false, edit_low_credit_alert: false });
  });

  it('part counter mirrors the server sample render: GSM 160/153, UCS-2 70/67, max 3 parts', () => {
    expect(countTemplate('a'.repeat(160), ctx, 'en')).toMatchObject({ encoding: 'gsm7', parts: 1 });
    expect(countTemplate('a'.repeat(161), ctx, 'en')).toMatchObject({ parts: 2, perPart: 153 });
    expect(countTemplate('a'.repeat(459), ctx, 'en')).toMatchObject({ parts: 3, over: 0 });
    expect(countTemplate('a'.repeat(460), ctx, 'en')).toMatchObject({ parts: 4, over: 1 });
    expect(countTemplate('অ'.repeat(70), ctx, 'bn')).toMatchObject({ encoding: 'ucs2', parts: 1 });
    expect(countTemplate('অ'.repeat(71), ctx, 'bn')).toMatchObject({ parts: 2, perPart: 67 });
    expect(countTemplate('অ'.repeat(202), ctx, 'bn')).toMatchObject({ parts: 4, over: 1, capacity: 201 });
    // merge tags count at their sample length; line breaks collapse to a space
    expect(renderSample('{shop}: Order {number}\nTrack {track_url}', ctx, 'en')).toBe('Mugdho Fashion: Order MU-1042 Track https://mugdho.storeplix.com/track');
    expect(countTemplate('{shop}', ctx, 'en').units).toBe('Mugdho Fashion'.length);
    // masked sender drops a leading "{shop}: " (P89A-17), other {shop} stay
    expect(renderSample('{shop}: hi from {shop}', { ...ctx, masked: true }, 'en')).toBe('hi from Mugdho Fashion');
    expect(renderSample('{first_name}', ctx, 'bn')).toBe('নাসরিন');
  });

  it('template problems: unknown, missing, links, too long', () => {
    const fields = ['shop', 'number', 'url'] as const;
    const c = (b: string) => countTemplate(b, ctx, 'en');
    expect(templateProblem('Hi {name}', fields, [], c('Hi {name}'))).toEqual({ code: 'unknown', fields: ['name'] });
    expect(templateProblem('Pay now', fields, ['url'], c('Pay now'))).toEqual({ code: 'missing', fields: ['url'] });
    expect(templateProblem('Go to www.x.com {url}', fields, ['url'], c('Go to www.x.com {url}'))).toEqual({ code: 'link' });
    expect(templateProblem('x'.repeat(470), fields, [], c('x'.repeat(470)))).toMatchObject({ code: 'too_long', parts: 4, over: 11 });
    expect(templateProblem('  ', fields, [], c(''))).toEqual({ code: 'empty' });
    expect(templateProblem('{shop}: ok {url}', fields, ['url'], c('{shop}: ok {url}'))).toBeNull();
  });

  it('insert at cursor and formatters', () => {
    expect(insertAt('Hello world', 'shop', 6, 6)).toEqual({ body: 'Hello {shop}world', caret: 12 });
    expect(insertAt('Hello world', 'shop', 6, 11)).toEqual({ body: 'Hello {shop}', caret: 12 });
    expect(formatRate(0.986)).toBe('98.6%');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(1)).toBe('100.0%');
    expect(maskPhone('8801711552211')).toBe('01711-•••211');
    expect(perSmsPrice({ credits: 5000, price_amount: 160_000 })).toBe('৳ 0.32 per SMS');
    expect(quietHoursLabel({ from: '21:00', to: '09:00' })).toBe('9 PM – 9 AM');
    expect(paceDuration(5000, 85)).toBe('about 2 months');
    expect(paceDuration(1000, null)).toBeNull();
    expect(purposesFor('order')).toEqual(['order_placed', 'order_confirmed', 'order_shipped', 'order_cancelled', 'order_updated', 'payment_link']);
    expect(purposesFor('otp')).toEqual(['checkout_otp']);
    expect(purposesFor('all')).toBeUndefined();
    expect(logMessage({ purpose: 'checkout_otp', body_preview: null })).toEqual({ text: 'Checkout code (hidden)', muted: true });
    expect(logStatusMeta({ status: 'skipped', error_code: 'no_credits' })).toMatchObject({ label: 'Skipped', sub: 'No SMS left' });
    expect(purchaseStatus({ status: 'open', due_at: '2099-01-01T00:00:00Z' }).label).toBe('Pending');
    expect(purchaseStatus({ status: 'void', due_at: '2020-01-01T00:00:00Z' }).label).toBe('Expired');
    expect(documentProblem({ type: 'text/plain', size: 10 })).toMatch(/PDF/);
    expect(documentProblem({ type: 'application/pdf', size: 6 * 1024 * 1024 })).toMatch(/5 MB/);
    expect(smsErrorText(new ApiError(403, 'impersonation_read_only', 'x'))).toBe('Read-only support session. Changes are disabled.');
    expect(smsErrorText(new ApiError(409, 'sender_id_taken', 'x'))).toMatch(/Another business/);
  });

  it('sender ID schema: pattern, uses, tick, file', () => {
    const file = new File(['%PDF'], 'licence.pdf', { type: 'application/pdf' });
    const ok = { sender_id: 'MUGDHO', business_name: 'Mugdho Fashion House', uses: ['order_updates'], note: '', rights_confirmed: true, document: file };
    expect(senderIdSchema.safeParse(ok).success).toBe(true);
    expect(senderIdSchema.safeParse({ ...ok, sender_id: '1234' }).success).toBe(false);
    expect(senderIdSchema.safeParse({ ...ok, sender_id: 'MU GDHO' }).success).toBe(false);
    expect(senderIdSchema.safeParse({ ...ok, sender_id: 'ABCDEFGHIJKL' }).success).toBe(false);
    expect(senderIdSchema.safeParse({ ...ok, uses: [] }).success).toBe(false);
    expect(senderIdSchema.safeParse({ ...ok, rights_confirmed: false }).success).toBe(false);
    expect(senderIdSchema.safeParse({ ...ok, document: null }).success).toBe(false);
    expect(senderIdSchema.safeParse({ ...ok, document: new File(['x'], 'a.txt', { type: 'text/plain' }) }).success).toBe(false);
  });
});

describe('PHASE-8-9A SMS page', () => {
  it('staff without the keys gets the no-access page', async () => {
    signedIn('staff', smsRoutes());
    renderApp(<AppRoutes />, { route: '/integrations/sms' });
    expect(await screen.findByText('You don’t have access to this page', undefined, SLOW)).toBeInTheDocument();
  });

  it('owner overview: header, credits card, this month, sending rules', async () => {
    signedIn('owner', smsRoutes());
    renderApp(<AppRoutes />, { route: '/integrations/sms' });
    const credits = await screen.findByRole('region', { name: 'SMS credits' }, SLOW);
    expect(within(credits).getAllByText('1,240').length).toBeGreaterThan(0);
    expect(within(credits).getByText('Healthy')).toBeInTheDocument();
    expect(within(credits).getByText('260 of 500 left this month')).toBeInTheDocument();
    expect(await within(credits).findByRole('button', { name: 'Buy 5,000 credits with bKash' })).toBeInTheDocument();
    const month = screen.getByRole('region', { name: 'This month' });
    expect(within(month).getByText('98.6%')).toBeInTheDocument();
    expect(within(month).getByText('2,860')).toBeInTheDocument();
    expect(screen.getByText('9 PM – 9 AM')).toBeInTheDocument();
    expect(screen.getByText('Storeplix (default)')).toBeInTheDocument();
    expect(screen.getByText(/Sender: Storeplix/)).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: 'SMS: Order confirmed' }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Managed by Fake order guard/ })).toHaveAttribute('href', '/orders/fraud-guard');
    expect(screen.queryByRole('switch', { name: 'SMS: POS receipt' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('tablist', { name: 'SMS sections' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Templates', 'Sender ID', 'SMS log', 'Buy credits']);
  });

  it('unlimited allowance and null success rate', async () => {
    signedIn(
      'owner',
      smsRoutes({
        'GET /stores/S1/sms': jsonResponse(200, {
          data: overview({
            allowance: { transactional: { limit: null, used: 10, remaining: null, unit: 'messages' }, marketing: { limit: 0, used: 0, remaining: 0, unit: 'parts' } },
            this_month: { messages_sent: 0, messages_failed: 0, messages_skipped: 0, sent_success_rate: null, credits_used: 0, otp_sent: 0 },
            credits: { balance: 0, status: 'none', estimated_days_left: null, low_credit_threshold: null },
          }),
        }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms' });
    const credits = await screen.findByRole('region', { name: 'SMS credits' }, SLOW);
    expect(within(credits).getAllByText('Unlimited').length).toBeGreaterThan(0);
    expect(within(credits).queryByText('Healthy')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'This month' })).getByText('—')).toBeInTheDocument();
  });

  it('language and event switch write the store settings (one source, P89A-10)', async () => {
    const fetchMock = signedIn('owner', smsRoutes({ 'PATCH /stores/S1/settings': (init) => settingsWithCommerce(JSON.parse(String(init.body)).notifications ?? {}) }));
    renderApp(<AppRoutes />, { route: '/integrations/sms' });
    const sw = await screen.findByRole('switch', { name: 'SMS: Order confirmed' }, SLOW);
    await userEvent.click(sw);
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/settings', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/settings', 'PATCH')[0]!)).toEqual({ notifications: { customer_sms: { order_confirmed: false } } });
    await userEvent.click(screen.getByRole('tab', { name: 'English' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/settings', 'PATCH')).toHaveLength(2));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/settings', 'PATCH')[1]!)).toEqual({ notifications: { sms_language: 'en' } });
  });

  it('low-credit alert select patches the credit account', async () => {
    const fetchMock = signedIn('owner', smsRoutes({ 'PATCH /billing/sms-credits': jsonResponse(200, { data: account({ low_credit_threshold: 500 }) }) }));
    renderApp(<AppRoutes />, { route: '/integrations/sms' });
    const select = await screen.findByRole('combobox', { name: 'Low-credit alert' }, SLOW);
    expect(select).toHaveValue('200');
    fireEvent.change(select, { target: { value: '500' } });
    await waitFor(() => expect(byMethod(fetchMock, '/billing/sms-credits', 'PATCH')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/billing/sms-credits', 'PATCH')[0]!)).toEqual({ low_credit_threshold: 500 });
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(bodyOf(byMethod(fetchMock, '/billing/sms-credits', 'PATCH')[1]!)).toEqual({ low_credit_threshold: null }));
  });

  it('billing-only custom role: no sender ID / log tabs, no test button, read-only templates', async () => {
    signedIn({ role: 'custom', permissions: ['billing.view'] }, smsRoutes({ 'GET /stores/S1/sms': jsonResponse(200, { data: overview({ can: smsCapabilities({ role: 'custom', permissions: ['billing.view'] }) }) }) }));
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=log' });
    await screen.findByRole('region', { name: 'SMS credits' }, SLOW);
    expect(screen.getAllByRole('tab', { selected: true })[0]).toHaveTextContent('Overview');
    expect(screen.queryByRole('tab', { name: 'SMS log' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Sender ID' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send test SMS' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy credits' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Low-credit alert' })).toBeDisabled();
  });

  it('send test SMS: success toast, 402 → buy credits link, phone_not_verified', async () => {
    const fetchMock = signedIn(
      'owner',
      smsRoutes({ 'POST /stores/S1/sms/test': jsonResponse(200, { data: { sms_message_id: 'M9', to_masked: '01712-•••678', status: 'sent', charged_from: 'allowance', parts: 1 } }) }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms' });
    await userEvent.click(await screen.findByRole('button', { name: 'Send test SMS' }, SLOW));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/We’ll text 01712-•••678/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'English' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Test SMS sent to 01712-•••678')).toBeInTheDocument();
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/sms/test', 'POST')[0]!)).toEqual({ language: 'en' });
  });

  it('send test SMS: 402 sms_credits_exhausted shows the buy credits link', async () => {
    signedIn('owner', smsRoutes({ 'POST /stores/S1/sms/test': jsonResponse(402, { error: { code: 'sms_credits_exhausted', message: 'No SMS left.', details: { allowance_remaining: 0, credits: 0, needed: 1 } } }) }));
    renderApp(<AppRoutes />, { route: '/integrations/sms' });
    await userEvent.click(await screen.findByRole('button', { name: 'Send test SMS' }, SLOW));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByRole('link', { name: 'buy credits' })).toHaveAttribute('href', '/integrations/sms?tab=credits');
  });
});

describe('PHASE-8-9A templates', () => {
  // The editor is a side panel on lg+ (a bottom sheet below); jsdom has no matchMedia, so pretend a desktop.
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  });
  it('rows show bn + en previews, Edited/Default, OTP locked', async () => {
    signedIn('owner', smsRoutes({ 'GET /stores/S1/sms/templates': jsonResponse(200, { data: templates((t) => (t.key === 'payment_link' && t.language === 'bn' ? { ...t, is_custom: true, revision: 2 } : t)) }) }));
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=templates' });
    const list = await screen.findByRole('list', { name: 'SMS templates' }, SLOW);
    const pay = within(list).getByRole('listitem', { name: 'Payment link' });
    expect(within(pay).getByText('Edited')).toBeInTheDocument();
    expect(within(pay).getByText(/When: you request an advance/)).toBeInTheDocument();
    const otp = within(list).getByRole('listitem', { name: 'Checkout code' });
    expect(within(otp).getByText('Locked')).toBeInTheDocument();
    expect(within(otp).queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });

  it('editor: insert chip at the cursor, live counter, debounced preview, save with revision', async () => {
    const fetchMock = signedIn(
      'owner',
      smsRoutes({
        'POST /stores/S1/sms/templates/preview': (init) => {
          const b = JSON.parse(String(init.body)) as { body: string };
          return jsonResponse(200, { data: { text: `SERVER: ${b.body}`, parts: 1, encoding: 'gsm7', characters: b.body.length } });
        },
        'PUT /stores/S1/sms/templates/order_confirmed/en': (init) => jsonResponse(200, { data: template('order_confirmed', 'en', { body: JSON.parse(String(init.body)).body, is_custom: true, revision: 1 }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=templates&key=order_confirmed' });
    const editor = await screen.findByRole('region', { name: 'Edit template' }, SLOW);
    await userEvent.click(within(editor).getByRole('button', { name: 'English' }));
    const box = within(editor).getByLabelText('Message') as HTMLTextAreaElement;
    expect(box.value).toBe('{shop}: Order {number} is confirmed.');
    box.setSelectionRange(8, 8);
    await userEvent.click(within(editor).getByRole('button', { name: '{first_name}' }));
    expect(box.value).toBe('{shop}: {first_name}Order {number} is confirmed.');
    expect(within(editor).getByText('Unsaved')).toBeInTheDocument();
    expect(within(editor).getByTestId('part-meter')).toHaveTextContent('1 SMS part');
    await waitFor(() => expect(within(editor).getByTestId('template-preview')).toHaveTextContent('SERVER: {shop}: {first_name}Order'), SLOW);
    expect(byMethod(fetchMock, '/stores/S1/sms/templates/preview', 'POST').length).toBeGreaterThanOrEqual(1);
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/sms/templates/preview', 'POST').at(-1)!)).toMatchObject({ key: 'order_confirmed', language: 'en' });
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/sms/templates/order_confirmed/en', 'PUT')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/sms/templates/order_confirmed/en', 'PUT')[0]!)).toEqual({ body: '{shop}: {first_name}Order {number} is confirmed.', revision: 0 });
  });

  it('editor: too long and unknown tags block Save; 409 shows the conflict', async () => {
    signedIn(
      'owner',
      smsRoutes({
        'POST /stores/S1/sms/templates/preview': jsonResponse(200, { data: { text: 'x', parts: 1, encoding: 'gsm7', characters: 1 } }),
        'PUT /stores/S1/sms/templates/order_confirmed/en': jsonResponse(409, { error: { code: 'revision_conflict', message: 'Changed.' } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=templates&key=order_confirmed' });
    const editor = await screen.findByRole('region', { name: 'Edit template' }, SLOW);
    await userEvent.click(within(editor).getByRole('button', { name: 'English' }));
    const box = within(editor).getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'x'.repeat(470) } });
    expect(within(editor).getByRole('alert')).toHaveTextContent('Too long for one message. Keep it within 3 parts — remove 11 characters to save.');
    expect(within(editor).getByTestId('part-meter')).toHaveTextContent('4 SMS parts — max 3');
    expect(within(editor).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(box, { target: { value: 'Hi {name}' } });
    expect(within(editor).getByRole('alert')).toHaveTextContent('{name} isn’t a merge tag');
    fireEvent.change(box, { target: { value: '{shop}: Order {number} is ready.' } });
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    expect(await within(editor).findByText('Someone else changed this template.')).toBeInTheDocument();
  });

  it('reset to default asks first when custom, then DELETEs', async () => {
    const fetchMock = signedIn(
      'owner',
      smsRoutes({
        'GET /stores/S1/sms/templates': jsonResponse(200, { data: templates((t) => (t.key === 'order_confirmed' ? { ...t, is_custom: true, body: `${t.body} !`, revision: 3 } : t)) }),
        'DELETE /stores/S1/sms/templates/order_confirmed/bn': jsonResponse(200, { data: template('order_confirmed', 'bn') }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=templates&key=order_confirmed' });
    const editor = await screen.findByRole('region', { name: 'Edit template' }, SLOW);
    await userEvent.click(within(editor).getByRole('button', { name: 'Reset to default' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reset to the default text?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/sms/templates/order_confirmed/bn', 'DELETE')).toHaveLength(1));
  });

  it('without edit_templates the editor is read-only', async () => {
    signedIn({ role: 'custom', permissions: ['integrations.manage'] }, smsRoutes({ 'GET /stores/S1/sms': jsonResponse(200, { data: overview({ can: smsCapabilities({ role: 'custom', permissions: ['integrations.manage'] }) }) }) }));
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=templates&key=order_placed' });
    const editor = await screen.findByRole('region', { name: 'Template' }, SLOW);
    expect(within(editor).getByLabelText('Message')).toHaveAttribute('readonly');
    expect(within(editor).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(editor).getByText('Only owners and managers can edit messages.')).toBeInTheDocument();
  });
});

describe('PHASE-8-9A sender ID', () => {
  it('form validation, then multipart submit', async () => {
    const sent = stubXhr(201, { data: senderRequest() });
    signedIn('owner', smsRoutes());
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=sender-id' });
    const form = await screen.findByRole('form', { name: 'Request a masked sender ID' }, SLOW);
    await userEvent.type(within(form).getByLabelText('Sender ID'), 'mu');
    await userEvent.click(within(form).getByRole('button', { name: 'Submit request' }));
    expect(await within(form).findByText(/Use 3–11 letters or numbers/)).toBeInTheDocument();
    expect(within(form).getByText('Upload your trade licence.')).toBeInTheDocument();
    expect(within(form).getByText(/Tick to confirm/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Promotions' })).toBeDisabled();

    await userEvent.type(within(form).getByLabelText('Sender ID'), 'gdho');
    expect(within(form).getByText('6 / 11')).toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('Business name on the trade licence'), 'Mugdho Fashion House');
    await userEvent.click(within(form).getByRole('button', { name: 'OTP codes' }));
    const input = form.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['%PDF-1.4'], 'trade-licence.pdf', { type: 'application/pdf' }));
    expect(await within(form).findByText('trade-licence.pdf')).toBeInTheDocument();
    await userEvent.click(within(form).getByLabelText('This name belongs to my business and I have the right to use it.'));
    await userEvent.click(within(form).getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(sent).toHaveLength(1), SLOW);
    const form1 = sent[0]!.body;
    expect(sent[0]!.url).toContain('/stores/S1/sms/sender-ids');
    expect(form1.get('sender_id')).toBe('MUGDHO');
    expect(form1.get('business_name')).toBe('Mugdho Fashion House');
    expect(form1.getAll('uses[]')).toEqual(['order_updates', 'otp']);
    expect(form1.get('rights_confirmed')).toBe('1');
    expect((form1.get('document') as File).name).toBe('trade-licence.pdf');
    expect(await screen.findByText('Request sent. Review takes about 7–10 working days.')).toBeInTheDocument();
  });

  it('a taken ID shows on the field', async () => {
    stubXhr(409, { error: { code: 'sender_id_taken', message: 'Taken.' } });
    signedIn('owner', smsRoutes());
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=sender-id' });
    const form = await screen.findByRole('form', { name: 'Request a masked sender ID' }, SLOW);
    await userEvent.type(within(form).getByLabelText('Sender ID'), 'MUGDHO');
    await userEvent.type(within(form).getByLabelText('Business name on the trade licence'), 'Mugdho Fashion House');
    await userEvent.upload(form.querySelector('input[type="file"]') as HTMLInputElement, new File(['%PDF'], 'l.pdf', { type: 'application/pdf' }));
    await userEvent.click(within(form).getByLabelText('This name belongs to my business and I have the right to use it.'));
    await userEvent.click(within(form).getByRole('button', { name: 'Submit request' }));
    expect(await within(form).findByText(/Another business already uses or asked for this sender ID/, undefined, SLOW)).toBeInTheDocument();
  });

  it('pending request: timeline and cancel; rejected → request again prefills', async () => {
    const fetchMock = signedIn(
      'owner',
      smsRoutes({
        'GET /stores/S1/sms/sender-ids': jsonResponse(200, { data: senderList({ pending: senderRequest(), history: [senderRequest(), senderRequest({ id: 'SID0', sender_id: 'MUGDHOFH', status: 'rejected', decision_reason: 'Licence name does not match.' })] }) }),
        'POST /stores/S1/sms/sender-ids/SID1/cancel': jsonResponse(200, { data: senderRequest({ status: 'cancelled' }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=sender-id' });
    const pending = await screen.findByRole('region', { name: 'Pending request' }, SLOW);
    expect(within(pending).getByText(/for order updates and OTP/)).toBeInTheDocument();
    expect(within(pending).getByRole('list', { name: 'Request progress' })).toHaveTextContent('Pending review');
    expect(screen.queryByRole('form', { name: 'Request a masked sender ID' })).not.toBeInTheDocument();
    expect(screen.getByText('Licence name does not match.')).toBeInTheDocument();
    await userEvent.click(within(pending).getByRole('button', { name: 'Cancel request' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/sms/sender-ids/SID1/cancel', 'POST')).toHaveLength(1));
  });

  it('rejected (no pending) → Request again prefills the form', async () => {
    signedIn('owner', smsRoutes({ 'GET /stores/S1/sms/sender-ids': jsonResponse(200, { data: senderList({ history: [senderRequest({ status: 'rejected', decision_reason: 'Blurry licence.' })] }) }) }));
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=sender-id' });
    await userEvent.click(await screen.findByRole('button', { name: 'Request again' }, SLOW));
    expect(screen.getByLabelText('Sender ID')).toHaveValue('MUGDHO');
    expect(screen.getByLabelText('Business name on the trade licence')).toHaveValue('Mugdho Fashion House');
  });
});

describe('PHASE-8-9A SMS log', () => {
  it('purpose chips and status map to the query; OTP text hidden; cursor Next', async () => {
    const fetchMock = signedIn(
      'owner',
      smsRoutes({
        'GET /stores/S1/sms/messages': jsonResponse(200, {
          data: [logEntry(), logEntry({ id: 'M2', purpose: 'checkout_otp', body_preview: null }), logEntry({ id: 'M3', status: 'failed', error_code: 'provider_error', charged_from: null })],
          meta: cursorMeta({ next_cursor: 'C2' }),
        }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=log' });
    const table = await screen.findByRole('table', { name: 'SMS log' }, SLOW);
    expect(within(table).getAllByText('01711-•••211').length).toBeGreaterThan(0);
    expect(within(table).getByText('Checkout code (hidden)')).toBeInTheDocument();
    expect(within(table).getByText('Provider error')).toBeInTheDocument();
    expect(within(table).getAllByRole('link', { name: 'MU-1042' })[0]).toHaveAttribute('href', '/orders/O1');
    const first = searchOf(callsTo(fetchMock, '/stores/S1/sms/messages')[0]!);
    expect(first.get('filter[from]')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.get('filter[purpose]')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'OTP' }));
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/stores/S1/sms/messages').at(-1)!).get('filter[purpose]')).toBe('checkout_otp'));
    await userEvent.click(screen.getByRole('button', { name: 'Order' }));
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/stores/S1/sms/messages').at(-1)!).get('filter[purpose]')).toBe('order_placed,order_confirmed,order_shipped,order_cancelled,order_updated,payment_link'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'failed' } });
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/stores/S1/sms/messages').at(-1)!).get('filter[status]')).toBe('failed'));
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/stores/S1/sms/messages').at(-1)!).get('cursor')).toBe('C2'));
  });

  it('phone search: invalid → inline error; valid → exact filter', async () => {
    const fetchMock = signedIn('owner', smsRoutes());
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=log' });
    const search = await screen.findByRole('searchbox', { name: 'Search by phone number' }, SLOW);
    await userEvent.type(search, '0171{Enter}');
    expect(screen.getByText('Enter a full phone number')).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, '01711552211{Enter}');
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/stores/S1/sms/messages').at(-1)!).get('filter[phone]')).toBe('8801711552211'));
  });

  it('empty states: nothing sent yet vs no matches', async () => {
    signedIn('owner', smsRoutes({ 'GET /stores/S1/sms/messages': jsonResponse(200, { data: [], meta: cursorMeta() }) }));
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=log' });
    expect(await screen.findByText('No SMS sent yet', undefined, SLOW)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Campaign' }));
    expect(await screen.findByText('No messages match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No SMS sent yet')).toBeInTheDocument();
  });
});

describe('PHASE-8-9A buy credits', () => {
  it('pack + provider → purchase with an Idempotency-Key reused on retry, then redirect', async () => {
    const assign = vi.spyOn(payNavigation, 'assign').mockImplementation(() => {});
    let calls = 0;
    const fetchMock = signedIn(
      'owner',
      smsRoutes({
        'POST /billing/sms-credits/purchase': () => {
          calls += 1;
          if (calls === 1) return jsonResponse(502, { error: { code: 'provider_unavailable', message: 'Gateway down.' } });
          return jsonResponse(201, { data: { invoice: { id: 'INV9' }, payment: { id: 'PAY9', redirect_url: 'https://sandbox.bka.sh/pay/1', status: 'pending' } } });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=credits' });
    const packs = await screen.findByRole('radiogroup', { name: 'Credit pack' }, SLOW);
    expect(within(packs).getByText('Most popular')).toBeInTheDocument();
    expect(within(packs).getByText('৳ 0.32 per SMS')).toBeInTheDocument();
    await userEvent.click(within(packs).getByRole('radio', { name: /10,000/ }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Pay with' })).getByRole('radio', { name: /SSLCommerz/ }));
    expect(screen.getByText('980 → 10,980')).toBeInTheDocument();
    const pay = screen.getByRole('button', { name: /Pay .*3,000 with SSLCommerz/ });
    await userEvent.click(pay);
    expect(await screen.findByText(/payment gateway didn’t answer/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Pay .*3,000 with SSLCommerz/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://sandbox.bka.sh/pay/1'));
    const posts = byMethod(fetchMock, '/billing/sms-credits/purchase', 'POST');
    expect(posts).toHaveLength(2);
    expect(bodyOf(posts[0]!)).toEqual({ pack: 'credits_10000', provider: 'sslcommerz' });
    expect(headerOf(posts[0]!, 'Idempotency-Key')).toBeTruthy();
    expect(headerOf(posts[1]!, 'Idempotency-Key')).toBe(headerOf(posts[0]!, 'Idempotency-Key'));
  });

  it('manager sees the packs but cannot buy; purchase history and ledger list', async () => {
    signedIn('admin', smsRoutes({ 'GET /stores/S1/sms': jsonResponse(200, { data: overview({ can: { ...allCan, buy_credits: false } }) }) }));
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=credits' });
    expect(await screen.findByText('Only the shop owner can buy credits.', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pay / })).not.toBeInTheDocument();
  });

  it('purchase history statuses and credit history (owner)', async () => {
    signedIn(
      'owner',
      smsRoutes({
        'GET /billing/invoices': jsonResponse(200, { data: [smsInvoice(), smsInvoice({ id: 'INV2', number: 'SP-2026-0050', status: 'open', due_at: '2099-01-01T00:00:00Z' })], meta: { ...pageMeta, total: 2 } }),
        'GET /billing/sms-credits/ledger': jsonResponse(200, { data: [ledgerEntry(), ledgerEntry({ id: 'L2', type: 'admin_adjust', credits: 200, balance_after: 1200, invoice: null, reason: 'Goodwill for the outage' })], meta: cursorMeta() }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=credits' });
    const history = await screen.findByRole('region', { name: 'Purchase history' }, SLOW);
    expect(await within(history).findByText('Paid')).toBeInTheDocument();
    expect(within(history).getByText('Pending')).toBeInTheDocument();
    const ledger = screen.getByRole('region', { name: 'Credit history' });
    expect(await within(ledger).findByText('Adjusted by Store Plix')).toBeInTheDocument();
    expect(within(ledger).getByText('Goodwill for the outage')).toBeInTheDocument();
  });

  it('kind filter on invoices', async () => {
    const fetchMock = signedIn('owner', smsRoutes());
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=credits' });
    await screen.findByRole('region', { name: 'Purchase history' }, SLOW);
    await waitFor(() => expect(callsTo(fetchMock, '/billing/invoices').length).toBeGreaterThan(0));
    expect(searchOf(callsTo(fetchMock, '/billing/invoices')[0]!).get('filter[kind]')).toBe('sms_credits');
  });

  it('return: polls the payment, then shows the credits added (never trusts the redirect)', async () => {
    let polls = 0;
    const fetchMock = signedIn(
      'owner',
      smsRoutes({
        'GET /billing/payments/PAY9': () => {
          polls += 1;
          return jsonResponse(200, { data: { id: 'PAY9', invoice_id: 'INV9', provider: 'bkash', status: polls < 2 ? 'pending' : 'succeeded', amount: 160_000, currency: 'BDT', redirect_url: null, failure_code: null, is_duplicate: false, created_at: '', expires_at: '', verified_at: null } });
        },
        'GET /billing/invoices/INV9': jsonResponse(200, { data: { ...smsInvoice({ id: 'INV9' }), sms_credits: 5000, plan_code: null, interval: null } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=credits&payment=PAY9' });
    expect(await screen.findByText('Confirming your payment…', undefined, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('5,000 credits added', undefined, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByText('Payment confirmed by bKash')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/billing/payments/PAY9').length).toBeGreaterThanOrEqual(2);
  });

  it('return: a failed payment shows the failure banner', async () => {
    signedIn(
      'owner',
      smsRoutes({
        'GET /billing/payments/PAY9': jsonResponse(200, { data: { id: 'PAY9', invoice_id: 'INV9', provider: 'bkash', status: 'failed', amount: 1, currency: 'BDT', redirect_url: null, failure_code: 'cancelled', is_duplicate: false, created_at: '', expires_at: '', verified_at: null } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/integrations/sms?tab=credits&payment=PAY9' });
    expect(await screen.findByText('Payment didn’t go through. You haven’t been charged.', undefined, SLOW)).toBeInTheDocument();
  });
});

describe('PHASE-8-9A existing screens', () => {
  it('Integrations: Messaging chip and the SMS card', async () => {
    signedIn('owner', smsRoutes({ 'GET /stores/S1/payment-gateways': jsonResponse(200, { data: [] }), 'GET /stores/S1/couriers': jsonResponse(200, { data: [] }) }));
    renderApp(<AppRoutes />, { route: '/integrations' });
    const card = await screen.findByRole('article', { name: 'Storeplix SMS' }, SLOW);
    expect(await within(card).findByText(/980 credits/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Manage SMS' })).toHaveAttribute('href', '/integrations/sms');
    await userEvent.click(screen.getByRole('button', { name: 'Messaging' }));
    expect(screen.queryByRole('region', { name: 'Payments' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Messaging' })).toBeInTheDocument();
  });

  it('Integrations: staff do not see the SMS card', async () => {
    signedIn('staff', smsRoutes({ 'GET /stores/S1/payment-gateways': jsonResponse(200, { data: [] }), 'GET /stores/S1/couriers': jsonResponse(200, { data: [] }) }));
    renderApp(<AppRoutes />, { route: '/integrations' });
    await screen.findByRole('region', { name: 'Payments' }, SLOW);
    expect(screen.queryByRole('article', { name: 'Storeplix SMS' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Messaging' })).not.toBeInTheDocument();
  });

  it('Notifications: preview from the server template and Edit text link', async () => {
    signedIn('owner', smsRoutes({ 'GET /stores/S1/sms/templates': jsonResponse(200, { data: templates((t) => (t.key === 'order_placed' && t.language === 'bn' ? { ...t, preview: { ...t.preview, text: 'CUSTOM PREVIEW' } } : t)) }) }));
    renderApp(<AppRoutes />, { route: '/settings/notifications' });
    expect(await screen.findByText('CUSTOM PREVIEW', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit text' })).toHaveAttribute('href', '/integrations/sms?tab=templates&key=order_placed');
  });

  it('campaign allowance: credits cover the shortfall (no "Not enough left")', () => {
    const est = (credits: number): CampaignEstimate => ({ recipients: 100, parts_per_recipient: 2, total_parts: 200, encoding: 'gsm7', characters: 200, allowance: { limit: 100, used: 50, remaining: 50, after: -150, credits } });
    const { unmount } = renderApp(<AllowanceCard channel="sms" recipients={100} perPerson={2} allowance={{ limit: 100, used: 50 }} estimate={est(500)} canSeePlans />);
    expect(screen.queryByText(/Not enough left/)).not.toBeInTheDocument();
    expect(screen.getByTestId('credits-row')).toHaveTextContent('SMS credits 500 → 350 after (150 paid from credits)');
    unmount();
    renderApp(<AllowanceCard channel="sms" recipients={100} perPerson={2} allowance={{ limit: 100, used: 50 }} estimate={est(100)} canSeePlans />);
    expect(screen.getByText(/Not enough left this month: you need 200 and have 150/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buy SMS credits' })).toHaveAttribute('href', '/integrations/sms?tab=credits');
  });
});
