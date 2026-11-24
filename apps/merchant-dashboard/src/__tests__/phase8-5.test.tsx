import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import {
  campaignActions,
  inQuietHours,
  insertAt,
  isoToZoned,
  partSegments,
  renderSms,
  scheduleProblem,
  segmentLabel,
  smsHint,
  unknownMergeFields,
  validateComposer,
  withParams,
  withSegment,
  zonedToIso,
  fromCampaign,
} from '../campaigns/campaigns';
import { smsParts } from '../campaigns/smsParts';
import { CAMPAIGN_TEMPLATES } from '../campaigns/templates';
import { visibleNav } from '../layout/nav';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { customer } from './catalog.fixtures';
import { features } from './phase7.fixtures';
import { campaign, estimate, marketingRoutes, recipient } from './phase8-5.fixtures';

// PHASE-8-5 §11 Web: helpers (SMS parts against the shared vectors, store tz, quiet hours), overview from fixture with the
// hidden tiles absent, campaigns list tabs + menu by state, composer (channel switch, segment params, preview counts,
// merge tag insert, counter, allowance, quiet hours, schedule payload in store tz, test send), detail, customer row.

const SLOW = { timeout: 5000 };
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Vector = { name: string; text: string; encoding: 'gsm7' | 'ucs2'; units: number; parts: number };
const vectors = (JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/api/sms-parts-vectors.json'), 'utf8')) as { vectors: Vector[] }).vectors;

describe('smsParts (docs/api/sms-parts-vectors.json)', () => {
  it('has the shared vectors', () => expect(vectors.length).toBeGreaterThanOrEqual(20));
  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const c = smsParts(v.text);
    expect({ encoding: c.encoding, units: c.units, parts: c.parts }).toEqual({ encoding: v.encoding, units: v.units, parts: v.parts });
  });
});

describe('PHASE-8-5 helpers', () => {
  it('renders the SMS with the shop prefix and the opt-out footer, and counts them', () => {
    const s = renderSms('Hi {name}, code {coupon} at {shop_link}', { channel: 'sms', language: 'en', shopName: 'Mugdho Fashion House Dhaka', host: 'mugdho.storeplix.com', couponCode: 'EID20', product: null });
    expect(s.prefix).toBe('Mugdho Fashion House: ');
    expect(s.text).toBe('Mugdho Fashion House: Hi Nasrin Akter Chowdhu, code EID20 at mugdho.storeplix.com\nSTOP: mugdho.storeplix.com/u/Ab3dE5gH7k');
    expect(s.count.encoding).toBe('gsm7');
    const bn = renderSms('প্রিয় {name}', { channel: 'sms', language: 'bn', shopName: 'Mugdho', host: 'm.com', couponCode: null, product: null });
    expect(bn.footer).toBe('বন্ধ করতে: m.com/u/Ab3dE5gH7k');
    expect(bn.count.encoding).toBe('ucs2');
  });

  it('hint, part bar and merge fields', () => {
    const two = smsParts('অ'.repeat(118));
    expect(two.parts).toBe(2);
    expect(smsHint(two)).toBe('Bangla SMS fits 70 characters each. Cut 48 characters to send 1 SMS.');
    expect(partSegments(two)).toEqual([
      { size: 67, filled: true },
      { size: 51, filled: true },
      { size: 16, filled: false },
    ]);
    expect(unknownMergeFields('Hi {name} {first_name} {coupon}')).toEqual(['first_name']);
    expect(insertAt('Hi', '{name}', 2)).toEqual({ text: 'Hi {name}', caret: 9 });
  });

  it('store timezone, quiet hours and schedule bounds', () => {
    expect(zonedToIso('2026-12-04', '10:30', 'Asia/Dhaka')).toBe('2026-12-04T04:30:00.000Z');
    expect(isoToZoned('2026-12-04T04:30:00Z', 'Asia/Dhaka')).toEqual({ date: '2026-12-04', time: '10:30' });
    expect(inQuietHours(Date.parse('2026-12-04T15:00:00Z'), 'Asia/Dhaka')).toBe(true); // 21:00 Dhaka
    expect(inQuietHours(Date.parse('2026-12-04T02:59:00Z'), 'Asia/Dhaka')).toBe(true); // 08:59
    expect(inQuietHours(Date.parse('2026-12-04T03:00:00Z'), 'Asia/Dhaka')).toBe(false); // 09:00
    const now = Date.parse('2026-12-01T06:00:00Z');
    expect(scheduleProblem('2026-12-01T06:02:00Z', 'Asia/Dhaka', now)).toMatch(/5 minutes/);
    expect(scheduleProblem('2027-04-01T06:00:00Z', 'Asia/Dhaka', now)).toMatch(/90 days/);
    expect(scheduleProblem('2026-12-02T16:00:00Z', 'Asia/Dhaka', now)).toMatch(/9 PM and 9 AM/);
    expect(scheduleProblem('2026-12-02T06:00:00Z', 'Asia/Dhaka', now)).toBeNull();
  });

  it('segments: typed params, labels, actions by state', () => {
    const a = withSegment('repeat_inactive');
    expect(a).toEqual({ segment: 'repeat_inactive', params: { min_orders: 2, inactive_days: 60 }, exclude: { risky: true, ordered_within_days: 7 } });
    expect(segmentLabel(withParams(a, { min_orders: 3 }))).toBe('Bought 3+ times, inactive 60 days');
    expect(withSegment('all', a)).toEqual({ segment: 'all', params: {}, exclude: a.exclude });
    expect(segmentLabel(withSegment('vip'))).toBe('VIP · spent over ৳ 20,000');
    expect(campaignActions('scheduled')).toMatchObject({ edit: true, unschedule: true, cancel: true, remove: false });
    expect(campaignActions('sent')).toMatchObject({ edit: false, cancel: false, remove: false, duplicate: true });
  });

  it('composer validation and templates', () => {
    const f = { ...fromCampaign(null, 'Asia/Dhaka'), body: 'Hi {coupon}', channel: 'email' as const };
    expect(validateComposer(f, null)).toEqual({ body: 'Pick a coupon for {coupon}.', subject: 'Add a subject.' });
    expect(CAMPAIGN_TEMPLATES.map((t) => t.label)).toEqual(['Win-back with coupon', 'New arrivals', 'Flash sale', 'Eid greeting']);
    for (const t of CAMPAIGN_TEMPLATES) for (const l of ['bn', 'en'] as const) expect(unknownMergeFields(t.text[l].body)).toEqual([]);
  });

  it('nav: Overview and Campaigns need marketing.manage', () => {
    const marketing = (role: 'owner' | 'staff') => visibleNav({ role }).find((n) => n.to === '/marketing')!.children!.map((c) => c.label);
    expect(marketing('owner')).toEqual(['Overview', 'Coupons', 'Campaigns', 'Automations']); // + Automations (PHASE-8-6 §10)
    expect(marketing('staff')).toEqual(['Coupons']);
  });
});

describe('Marketing overview', () => {
  it('renders KPIs, chart, coupons, quick create and recent campaigns; out-of-scope pieces are absent', async () => {
    signedIn('owner', marketingRoutes());
    renderApp(<AppRoutes />, { route: '/marketing' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Marketing' }, SLOW)).toBeInTheDocument();
    const kpis = await screen.findByRole('region', { name: 'Marketing summary' }, SLOW);
    expect(within(kpis).getByText('Revenue from marketing')).toBeInTheDocument();
    expect(within(kpis).getByText('↑ 22% vs last 30 days')).toBeInTheDocument();
    expect(within(kpis).getByText('18% of all orders')).toBeInTheDocument();
    expect(within(kpis).getByText('SMS + email, this month: 20 of 6,000')).toBeInTheDocument();
    // PHASE-8-6 §10.5: Carts recovered, the Automations tab, Cart recovery series and quick card are unhidden.
    expect(within(kpis).getByText('Carts recovered')).toBeInTheDocument();
    for (const hidden of ['Return on spend', 'WhatsApp broadcast', 'SMS & WhatsApp'])
      expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    expect(screen.queryByText(/Best week yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/per SMS/)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Campaigns\s*14/ })).toBeInTheDocument();
    expect(screen.getByText('EID25')).toBeInTheDocument();
    expect(screen.getByText('184 used of 500')).toBeInTheDocument();
    expect(screen.getByText('96 used · no limit')).toBeInTheDocument();
    expect(screen.getByText('Email campaign')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Write email' })).toHaveAttribute('href', '/marketing/campaigns/new?channel=email');
    const recent = screen.getByRole('table', { name: 'Recent campaigns' });
    expect(within(recent).getByText('Come back for 15% off')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all 14 →' })).toBeInTheDocument();
  });

  it('Free plan: plan note, create campaign disabled', async () => {
    signedIn('owner', marketingRoutes({ features: features() }));
    renderApp(<AppRoutes />, { route: '/marketing' });
    expect(await screen.findByText('Campaigns are part of the Starter plan.', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New campaign' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Write SMS' })).toBeDisabled();
  });

  it('staff without marketing.manage is sent to Coupons; Campaigns is forbidden', async () => {
    signedIn('staff', { ...marketingRoutes(), 'GET /stores/S1/coupons': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, counts: { all: 0, active: 0, scheduled: 0, expired: 0 } } }) });
    renderApp(<AppRoutes />, { route: '/marketing/campaigns' });
    expect(await screen.findByText('You don’t have access to this page', {}, SLOW)).toBeInTheDocument();
  });
});

describe('Campaigns list', () => {
  it('status tabs filter by status; the row menu follows the state', async () => {
    const fetchMock = signedIn('owner', marketingRoutes());
    renderApp(<AppRoutes />, { route: '/marketing/campaigns' });
    const table = await screen.findByRole('table', { name: 'Campaigns' }, SLOW);
    expect(await within(table).findByText('Friday flash sale', {}, SLOW)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Friday flash sale' }));
    expect(screen.getByRole('menuitem', { name: 'Unschedule' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Cancel campaign' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete draft' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Eid draft' }));
    expect(screen.getByRole('menuitem', { name: 'Delete draft' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Unschedule' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Come back for 15% off' }));
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('tab', { name: 'Scheduled' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/campaigns').some(([url]) => new URL(url, 'http://x').searchParams.get('filter[status]') === 'scheduled')).toBe(true));
  });

  it('empty state offers a new campaign', async () => {
    signedIn('owner', marketingRoutes({ list: [] }));
    renderApp(<AppRoutes />, { route: '/marketing/campaigns' });
    expect(await screen.findByText('No campaigns yet', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New campaign' })).toBeInTheDocument();
  });
});

describe('Campaign composer', () => {
  it('channel cards, segment params, preview counts, counter, merge tag and allowance', async () => {
    signedIn('owner', marketingRoutes());
    renderApp(<AppRoutes />, { route: '/marketing/campaigns/new' });
    expect(await screen.findByRole('heading', { level: 1, name: 'New campaign' }, SLOW)).toBeInTheDocument();
    const sms = screen.getByRole('radio', { name: /SMS/ });
    expect(sms).toBeChecked();
    expect(await screen.findByText('980 left', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/WhatsApp/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Top up/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Good pick/)).not.toBeInTheDocument();

    // Segment params.
    await userEvent.selectOptions(screen.getByLabelText('Send to segment'), 'repeat_inactive');
    expect(screen.getByLabelText('Bought at least (orders)')).toHaveValue(2);
    expect(screen.getByLabelText('Inactive for (days)')).toHaveValue(60);
    // Debounced audience preview.
    expect(await screen.findByText('197 customers will get this message', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Good 84% · Be careful 16% · Risky 0%')).toBeInTheDocument();
    expect(screen.getByText('Skip Risky customers (11)')).toBeInTheDocument();
    expect(screen.getByText('Skip anyone who ordered in the last 7 days (4)')).toBeInTheDocument();
    const optedOut = screen.getByRole('checkbox', { name: 'Opted-out customers are never messaged (2)' });
    expect(optedOut).toBeChecked();
    expect(optedOut).toBeDisabled();

    // Merge tag + counter.
    const box = screen.getByLabelText('Message text');
    fireEvent.change(box, { target: { value: 'প্রিয়' } });
    await userEvent.click(screen.getByRole('button', { name: '+ Customer name' }));
    expect((box as HTMLTextAreaElement).value).toBe('প্রিয় {name}');
    expect(screen.getByText(/^Unicode \(Bangla\) · \d+ characters$/)).toBeInTheDocument();
    expect(screen.getByTestId('sms-parts')).toHaveTextContent('SMS per person');
    expect(screen.getByTestId('sms-bubble')).toHaveTextContent('Mugdho Fashion: প্রিয় নাসরিন');
    expect(screen.getByTestId('sms-bubble')).toHaveTextContent('বন্ধ করতে: mugdho.storeplix.com/u/');

    // Allowance from the estimate.
    expect(await screen.findByText('Campaign SMS left this month 980 → 586 after', {}, SLOW)).toBeInTheDocument();

    // Switch to email: subject field, email preview.
    await userEvent.click(screen.getByRole('radio', { name: /Email/ }));
    expect(screen.getByLabelText('Subject')).toBeInTheDocument();
    expect(screen.getByTestId('email-preview')).toBeInTheDocument();
  });

  it('over allowance shows the danger row and See plans', async () => {
    signedIn('owner', { ...marketingRoutes(), 'POST /stores/S1/campaigns/estimate': jsonResponse(200, { data: estimate({ total_parts: 1200, allowance: { limit: 1000, used: 20, remaining: 980, after: -220 } }) }) });
    renderApp(<AppRoutes />, { route: '/marketing/campaigns/new' });
    fireEvent.change(await screen.findByLabelText('Message text', {}, SLOW), { target: { value: 'Hello' } });
    expect(await screen.findByText(/Not enough left this month/, {}, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toBeInTheDocument();
  });

  it('schedule: quiet-hours error inline, then a valid time posts scheduled_at in store time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-12-01T06:00:00Z') });
    const created = campaign({ id: 'C9', status: 'draft', started_at: null, completed_at: null, revision: 1 });
    const fetchMock = signedIn('owner', {
      ...marketingRoutes(),
      'POST /stores/S1/campaigns': jsonResponse(201, { data: created }),
      'GET /stores/S1/campaigns/C9': jsonResponse(200, { data: created }),
      'PATCH /stores/S1/campaigns/C9': jsonResponse(200, { data: { ...created, revision: 2 } }),
      'POST /stores/S1/campaigns/C9/schedule': jsonResponse(200, { data: { ...created, status: 'scheduled', scheduled_at: '2026-12-02T04:30:00Z' } }),
      'POST /stores/S1/campaigns/C9/test': jsonResponse(202, { data: { to_masked: '+880 17•• •••123' } }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp(<AppRoutes />, { route: '/marketing/campaigns/new' });
    fireEvent.change(await screen.findByLabelText('Message text', {}, SLOW), { target: { value: 'Hello {name}' } });
    await user.click(screen.getByRole('radio', { name: 'Schedule' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-12-02' } });
    fireEvent.change(screen.getByLabelText(/^Time/), { target: { value: '22:00' } });
    expect(await screen.findByText(/can’t start between 9 PM and 9 AM/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Time/).closest('label, div')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Time/), { target: { value: '10:30' } });
    await waitFor(() => expect(screen.queryByText(/can’t start between 9 PM and 9 AM/)).not.toBeInTheDocument());

    // Test send saves first, then posts /test.
    await user.click(screen.getByRole('button', { name: 'Send test to me' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/campaigns/C9/test')).toHaveLength(1));
    const createBody = JSON.parse(String(callsTo(fetchMock, '/stores/S1/campaigns').find(([, i]) => i.method === 'POST')![1].body));
    expect(createBody).toMatchObject({ channel: 'sms', body: 'Hello {name}', scheduled_at: '2026-12-02T04:30:00.000Z', audience: { segment: 'all', params: {}, exclude: { risky: true, ordered_within_days: 7 } } });

    await user.click(screen.getByRole('button', { name: 'Schedule campaign' }));
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    expect(within(dialog).getByText('197')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Schedule campaign' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/campaigns/C9/schedule')).toHaveLength(1));
    const [, init] = callsTo(fetchMock, '/stores/S1/campaigns/C9/schedule')[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ scheduled_at: '2026-12-02T04:30:00.000Z' });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });
});

describe('Composer regressions (QA gate)', () => {
  it('P85-QA-1: the estimate follows edits and the confirm dialog uses a fresh one', async () => {
    const created = campaign({ id: 'C7', status: 'draft', started_at: null, completed_at: null, revision: 1 });
    const fetchMock = signedIn('owner', {
      ...marketingRoutes(),
      'POST /stores/S1/campaigns/estimate': (init) => {
        const body = JSON.parse(String(init.body)) as { audience: { exclude: { ordered_within_days: number | null } } };
        const n = body.audience.exclude.ordered_within_days === null ? 2 : 1;
        return jsonResponse(200, { data: estimate({ recipients: n, total_parts: n }) });
      },
      'POST /stores/S1/campaigns': jsonResponse(201, { data: created }),
      'GET /stores/S1/campaigns/C7': jsonResponse(200, { data: created }),
    });
    renderApp(<AppRoutes />, { route: '/marketing/campaigns/new' });
    fireEvent.change(await screen.findByLabelText('Message text', {}, SLOW), { target: { value: 'Hi {name}' } });
    await userEvent.click(screen.getByRole('checkbox', { name: /Skip anyone who ordered/ }));
    await waitFor(
      () => {
        const last = callsTo(fetchMock, '/stores/S1/campaigns/estimate').at(-1);
        expect(last && JSON.parse(String(last[1].body))).toMatchObject({ body: 'Hi {name}', audience: { exclude: { ordered_within_days: null } } });
      },
      { timeout: 4000 },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send campaign' }));
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    expect(within(dialog).getByText('Recipients').nextElementSibling).toHaveTextContent('2');
  });

  it('P85-QA-8: a rate-limited audience preview says so', async () => {
    signedIn('owner', {
      ...marketingRoutes(),
      'POST /stores/S1/campaigns/audience-preview': jsonResponse(429, { error: { code: 'too_many_requests', message: 'Too many requests.' } }),
    });
    renderApp(<AppRoutes />, { route: '/marketing/campaigns/new' });
    expect(await screen.findByText(/Too many changes in a row/, {}, { timeout: 60_000 })).toBeInTheDocument();
  }, 70_000);
});

describe('Campaign detail', () => {
  it('shows stats, the message sample and masked recipients; sending shows the live banner', async () => {
    const sending = campaign({ status: 'sending', completed_at: null });
    signedIn('owner', {
      ...marketingRoutes(),
      'GET /stores/S1/campaigns/C1': jsonResponse(200, { data: sending }),
      'GET /stores/S1/campaigns/C1/recipients': jsonResponse(200, { data: [recipient(), recipient({ id: 'R2', customer: null, status: 'skipped', skip_reason: 'opted_out', sent_at: null, attributed_order: null })], meta: { next_cursor: null, prev_cursor: null, per_page: 50 } }),
    });
    renderApp(<AppRoutes />, { route: '/marketing/campaigns/C1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Come back for 15% off' }, SLOW)).toBeInTheDocument();
    expect(screen.getByText(/Sending now/)).toBeInTheDocument();
    expect(screen.getByTestId('stats-caption')).toHaveTextContent('0 failed · 3 skipped · 1 unsubscribed');
    expect(screen.getByTestId('message-sample')).toHaveTextContent('Mugdho Fashion: প্রিয় নাসরিন, অনেকদিন দেখা নেই! কোড WINTER15');
    const table = screen.getByRole('table', { name: 'Recipients' });
    expect(await within(table).findAllByText('+880 17•• •••123', {}, SLOW)).toHaveLength(2);
    expect(within(table).getByText('Opted out')).toBeInTheDocument();
    expect(within(table).getByText('#1042')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('recipients are hidden without customers.view', async () => {
    signedIn({ role: 'custom', permissions: ['marketing.manage'] }, { ...marketingRoutes(), 'GET /stores/S1/campaigns/C1': jsonResponse(200, { data: campaign() }) });
    renderApp(<AppRoutes />, { route: '/marketing/campaigns/C1' });
    expect(await screen.findByText('Recipient list hidden', {}, SLOW)).toBeInTheDocument();
  });
});

describe('Customer marketing row', () => {
  it('shows per-channel status and lets the merchant stop / allow again (merchant-owned only)', async () => {
    const c = customer({
      email: 'n@gmail.com',
      marketing: { sms: 'subscribed', email: 'unsubscribed', unsubscribed_sms_at: null, unsubscribed_email_at: '2026-11-20T00:00:00Z', unsubscribed_source: { sms: null, email: 'link' } },
    });
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/customers/CU1': jsonResponse(200, { data: c }),
      'GET /stores/S1/orders': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, counts: {} } }),
      'POST /stores/S1/customers/CU1/marketing-opt-out': jsonResponse(200, { data: { ...c.marketing, sms: 'unsubscribed', unsubscribed_source: { sms: 'merchant', email: 'link' } } }),
    });
    renderApp(<AppRoutes />, { route: '/customers/CU1' });
    const sms = await screen.findByTestId('marketing-sms', {}, SLOW);
    const email = screen.getByTestId('marketing-email');
    expect(within(sms).getByText('Subscribed')).toBeInTheDocument();
    expect(within(email).getByText('Unsubscribed 20 Nov (by customer)')).toBeInTheDocument();
    expect(within(email).queryByRole('button', { name: 'Allow again' })).not.toBeInTheDocument();
    await userEvent.click(within(sms).getByRole('button', { name: 'Stop marketing messages' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/customers/CU1/marketing-opt-out')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, '/stores/S1/customers/CU1/marketing-opt-out')[0]![1].body))).toEqual({ channel: 'sms' });
  });
});

