import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import {
  addableConditions,
  automationsLocked,
  messageProblem,
  recoveryPill,
  renderAutomationSms,
  runIcon,
  runLine,
  selectedChannelChips,
  stepLine,
  toggleChannelChip,
} from '../automations/automations';
import { smsParts } from '../campaigns/smsParts';
import { visibleNav } from '../layout/nav';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { automationRoutes, dryRun, freePlan, recoveryDetail, run, runs, thankYouDetail } from './phase8-6.fixtures';

// PHASE-8-6 §13 Web: automations page (hidden tiles/recipes absent, toggle → enable/disable, plan note), editor
// (conditions limited to the recipe, the 8.5 message editor with a 3-part counter against the shared vectors, dry run),
// recovery page (flow, step stats without Clicked, recent carts pills, rules), run log (filters, expand), overview items.

const SLOW = { timeout: 5000 };
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Vector = { name: string; text: string; encoding: 'gsm7' | 'ucs2'; units: number; parts: number };
const vectors = (JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/api/sms-parts-vectors.json'), 'utf8')) as { vectors: Vector[] }).vectors;

describe('PHASE-8-6 helpers', () => {
  it('3-part cap: messageProblem agrees with smsParts on every shared vector', () => {
    for (const v of vectors) {
      const parts = smsParts(v.text).parts;
      const p = messageProblem('thank_you', { channel: 'sms', language: 'en', body: 'x', subject: null }, parts);
      expect(p === null, v.name).toBe(parts <= 3);
    }
  });

  it('renders {cart_link} / {order_no} into the counted SMS with prefix and footer', () => {
    const s = renderAutomationSms('Hi {name} {cart_link} {order_no}', { language: 'en', shopName: 'Mugdho', host: 'm.com', couponCode: null });
    expect(s.text).toBe('Mugdho: Hi Nasrin Akter Chowdhu m.com/r/Ab3dE5gH7k GS-1048\nSTOP: m.com/u/Ab3dE5gH7k');
    expect(s.count.parts).toBe(1);
  });

  it('conditions: the add menu only offers the recipe’s free fields; channel chips', () => {
    expect(addableConditions(['order.total_amount', 'order.payment_method', 'order.channel', 'customer.tag'], [{ field: 'order.total_amount', op: 'gt', value: 1 }])).toEqual(['order.payment_method', 'customer.tag']);
    expect(addableConditions(['customer.delivered_orders_count'], [])).toEqual([]);
    expect(selectedChannelChips([]).size).toBe(6);
    const one = toggleChannelChip([], 'Facebook');
    expect(one).toEqual([{ field: 'order.channel', op: 'in', value: ['website', 'landing_page', 'instagram', 'phone', 'walk_in', 'other'] }]);
    expect(toggleChannelChip(one, 'Facebook')).toEqual([]);
  });

  it('run lines, icons and recovery pills', () => {
    expect(runLine(runs[0]!)).toBe('Sent to 01711-••••44');
    expect(stepLine(runs[2]!.steps[0]!)).toBe('Skipped · opted out');
    expect(runLine(runs[3]!)).toBe('Emailed 2 team members');
    expect(runIcon(runs[3]!).kind).toBe('mail');
    expect(runIcon(runs[1]!).kind).toBe('refresh');
    expect(recoveryPill(runs[0]!)).toEqual({ label: 'Recovered · SMS', tone: 'success' });
    expect(recoveryPill(runs[1]!)).toEqual({ label: 'Waiting · step 2', tone: 'warning' });
    expect(recoveryPill(runs[2]!).tone).toBe('danger');
    expect(recoveryPill(run({ conversion: null, status: 'running' })).label).toBe('SMS sent');
  });

  it('plan lock follows sms_automation', () => {
    expect(automationsLocked(freePlan())).toBe(true);
    expect(automationsLocked(undefined)).toBe(false);
  });

  it('nav: Automations after Campaigns, marketing.manage only', () => {
    const marketing = (role: 'owner' | 'staff') => visibleNav({ role }).find((n) => n.to === '/marketing')!.children!.map((c) => c.label);
    expect(marketing('owner')).toEqual(['Overview', 'Coupons', 'Campaigns', 'Automations']);
    expect(marketing('staff')).toEqual(['Coupons']);
  });
});

describe('Automations page', () => {
  it('KPIs, table, recent runs, recipe tiles; hidden tiles and recipes are absent', async () => {
    signedIn('owner', automationRoutes());
    renderApp(<AppRoutes />, { route: '/marketing/automations' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Automations' }, SLOW)).toBeInTheDocument();
    const kpis = await screen.findByRole('region', { name: 'Automations summary' }, SLOW);
    expect(within(kpis).getByText('1 draft · 3 total')).toBeInTheDocument();
    expect(within(kpis).getByText('99.6% succeeded')).toBeInTheDocument();
    expect(within(kpis).getByText('this month · 980 SMS left')).toBeInTheDocument();
    expect(within(kpis).getByText('Carts recovered')).toBeInTheDocument();
    for (const hidden of ['Risky orders held', 'Time saved', 'Order received SMS', 'Hold risky COD orders', 'Auto-book courier', 'Close COD orders automatically', 'Ask for a review', 'Cancel unpaid advance'])
      expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    expect(screen.queryByText(/WhatsApp/)).not.toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Your automations' });
    expect(within(table).getByText('Checkout left 30 min')).toBeInTheDocument();
    expect(within(table).getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Quiet hours 9 PM – 9 AM: messages wait until morning. Max 2 automated messages per customer a day.')).toBeInTheDocument();
    expect((await screen.findAllByText('Cart · 2 items · Win back unfinished orders', {}, SLOW)).length).toBe(3);
    expect(screen.getByText('Emailed 2 team members')).toBeInTheDocument();

    const tiles = screen.getByRole('region', { name: 'Start from a recipe' });
    expect(within(tiles).getByText('Tag VIP buyers')).toBeInTheDocument();
    expect(within(tiles).getByText('Handle returns')).toBeInTheDocument();
    expect(within(tiles).queryByText('Thank-you message')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Run log' })).toHaveAttribute('href', '/marketing/automations/runs');
  });

  it('the ON toggle enables / disables', async () => {
    const fetchMock = signedIn('owner', {
      ...automationRoutes(),
      'POST /stores/S1/automations/A1/disable': jsonResponse(200, { data: { ...recoveryDetail(), status: 'off' } }),
      'POST /stores/S1/automations/A2/enable': jsonResponse(422, { error: { code: 'automation_incomplete', message: 'x', details: { fields: ['message.body'] } } }),
    });
    renderApp(<AppRoutes />, { route: '/marketing/automations' });
    await userEvent.click(await screen.findByRole('switch', { name: 'Win back unfinished orders on' }, SLOW));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/automations/A1/disable')).toHaveLength(1));
    await userEvent.click(screen.getByRole('switch', { name: 'Thank-you message on' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/automations/A2/enable')).toHaveLength(1));
    expect(await screen.findByText(/Finish these first: message › body/, {}, SLOW)).toBeInTheDocument();
  });

  it('Use recipe creates the automation and opens the editor', async () => {
    const fetchMock = signedIn('owner', {
      ...automationRoutes(),
      'POST /stores/S1/automations': jsonResponse(201, { data: { ...thankYouDetail(), id: 'A9', recipe: 'vip_tag', name: 'Tag VIP buyers' } }),
      'GET /stores/S1/automations/A9': jsonResponse(404, { error: { code: 'not_found', message: 'x' } }),
    });
    renderApp(<AppRoutes />, { route: '/marketing/automations' });
    await userEvent.click(await screen.findByRole('button', { name: 'Use recipe Tag VIP buyers' }, SLOW));
    await waitFor(() => expect(JSON.parse(String(callsTo(fetchMock, '/stores/S1/automations').find(([, i]) => i.method === 'POST')![1].body))).toEqual({ recipe: 'vip_tag' }));
  });

  it('Free plan: plan note, toggles of off automations and Use recipe disabled', async () => {
    signedIn('owner', automationRoutes({ features: freePlan() }));
    renderApp(<AppRoutes />, { route: '/marketing/automations' });
    expect(await screen.findByText('Automations are part of the Starter plan.', {}, SLOW)).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: 'Thank-you message on' }, SLOW)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use recipe Tag VIP buyers' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ New automation' })).toBeDisabled();
  });

  it('empty and error states', async () => {
    signedIn('owner', { ...automationRoutes({ list: [] }) });
    const { unmount } = renderApp(<AppRoutes />, { route: '/marketing/automations' });
    expect(await screen.findByText('No automations yet', {}, SLOW)).toBeInTheDocument();
    unmount();
    signedIn('owner', { ...automationRoutes(), 'GET /stores/S1/automations': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) });
    renderApp(<AppRoutes />, { route: '/marketing/automations' });
    expect(await screen.findByText('We couldn’t load automations', {}, SLOW)).toBeInTheDocument();
  });

  it('staff can’t open Automations', async () => {
    signedIn('staff', automationRoutes());
    renderApp(<AppRoutes />, { route: '/marketing/automations' });
    expect(await screen.findByText('You don’t have access to this page', {}, SLOW)).toBeInTheDocument();
  });
});

describe('Recipe editor', () => {
  it('When chips (no Messenger / POS), conditions limited to the recipe, preview, Save sends the whole settings', async () => {
    const fetchMock = signedIn('owner', { ...automationRoutes(), 'PATCH /stores/S1/automations/A2': jsonResponse(200, { data: { ...thankYouDetail(), revision: 2 } }) });
    renderApp(<AppRoutes />, { route: '/marketing/automations/A2' });
    expect(await screen.findByRole('heading', { level: 1, name: /Thank-you message/ }, SLOW)).toBeInTheDocument();
    expect(screen.getByText(/last edited by Rafiqul Alam/)).toBeInTheDocument();
    const chips = screen.getByRole('group', { name: 'Order channels' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['Storefront', 'Landing pages', 'Facebook', 'Instagram', 'Phone / manual', 'Other']);
    expect(within(chips).queryByText('Messenger')).not.toBeInTheDocument();
    expect(within(chips).queryByText('POS')).not.toBeInTheDocument();
    expect(screen.queryByText('Courier success rate')).not.toBeInTheDocument();
    expect(screen.queryByText('+ Add action')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing happens. The run is logged as skipped.')).toBeInTheDocument();
    expect(screen.getByTestId('message-head')).toHaveTextContent('SMS · English · 1 part');
    expect(screen.getByText('Hi Nasrin, thanks for order GS-1048!')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(items).toEqual(['Order total', 'Payment method', 'Customer tag']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Payment method' }));
    await userEvent.click(within(chips).getByRole('button', { name: 'Facebook' }));

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/automations/A2').some(([, i]) => i.method === 'PATCH')).toBe(true));
    const body = JSON.parse(String(callsTo(fetchMock, '/stores/S1/automations/A2').find(([, i]) => i.method === 'PATCH')![1].body));
    expect(body.revision).toBe(1);
    expect(body.settings.delay_hours).toBe(0);
    expect(body.settings.conditions).toEqual([
      { field: 'order.channel', op: 'in', value: ['website', 'landing_page', 'instagram', 'phone', 'walk_in', 'other'] },
      { field: 'order.payment_method', op: 'is', value: 'cod' },
    ]);
  });

  it('Edit message opens the 8.5 editor with the recipe tags and a 3-part counter', async () => {
    signedIn('owner', automationRoutes());
    renderApp(<AppRoutes />, { route: '/marketing/automations/A2' });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit message' }, SLOW));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '+ Order number' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '+ Coupon code' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Template:/)).not.toBeInTheDocument();
    const box = within(dialog).getByLabelText('Message text');
    fireEvent.change(box, { target: { value: 'অ'.repeat(200) } });
    expect(within(dialog).getByTestId('sms-parts')).toHaveTextContent('4 SMS per person');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use this message' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Too long: 4 SMS per person. Keep it to 3.');
  });

  it('Test with an order shows the dry-run results', async () => {
    const fetchMock = signedIn('owner', { ...automationRoutes(), 'POST /stores/S1/automations/A2/dry-run': jsonResponse(200, { data: dryRun() }) });
    renderApp(<AppRoutes />, { route: '/marketing/automations/A2' });
    await userEvent.click(await screen.findByRole('button', { name: 'Run test' }, SLOW));
    const results = await screen.findByRole('list', { name: 'Test results' }, SLOW);
    expect(within(results).getByText(/Order total ৳ 3,980 is above ৳ 3,000/)).toBeInTheDocument();
    expect(within(results).getByText('Fails:')).toBeInTheDocument();
    expect(within(results).getByText(/thanks for order GS-1047/)).toBeInTheDocument();
    expect(JSON.parse(String(callsTo(fetchMock, '/stores/S1/automations/A2/dry-run')[0]![1].body))).toEqual({});
  });

  it('checkout recovery opens its own page', async () => {
    signedIn('owner', automationRoutes());
    renderApp(<AppRoutes />, { route: '/marketing/automations/A1' });
    expect(await screen.findByRole('heading', { level: 1, name: /Abandoned cart recovery/ }, SLOW)).toBeInTheDocument();
  });
});

describe('Abandoned cart recovery', () => {
  it('KPIs, flow, step stats without Clicked, recent carts pills and rules', async () => {
    signedIn('owner', automationRoutes());
    renderApp(<AppRoutes />, { route: '/marketing/automations/checkout-recovery' });
    expect(await screen.findByRole('heading', { level: 1, name: /Abandoned cart recovery/ }, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('Automation on', {}, SLOW)).toBeInTheDocument();
    const kpis = await screen.findByRole('region', { name: 'Cart recovery summary' }, SLOW);
    expect(within(kpis).getByText('312')).toBeInTheDocument();
    expect(within(kpis).getByText('18.6% recovery rate')).toBeInTheDocument();
    expect(within(kpis).getByText('Messages sent')).toBeInTheDocument();
    expect(within(kpis).queryByText('Cost')).not.toBeInTheDocument();

    expect(screen.getByText('Checkout started, not finished')).toBeInTheDocument();
    expect(screen.getByLabelText('Wait before step 1')).toHaveValue('30');
    const step1 = screen.getByRole('region', { name: 'Step 1' });
    expect(within(step1).getByText('Send SMS reminder')).toBeInTheDocument();
    expect(within(step1).getByText('284')).toBeInTheDocument();
    expect(within(step1).getByText('31 carts')).toBeInTheDocument();
    expect(screen.queryByText('Clicked')).not.toBeInTheDocument();
    expect(screen.queryByText(/WhatsApp/)).not.toBeInTheDocument();
    expect(screen.queryByText('Add a step')).not.toBeInTheDocument();
    expect(await screen.findByText('SMS + coupon COMEBACK10', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Stop when an order is placed')).toBeInTheDocument();
    expect(screen.getByText('No more messages')).toBeInTheDocument();

    const carts = screen.getByRole('region', { name: 'Recent carts' });
    expect(within(carts).getByText('Recovered · SMS')).toBeInTheDocument();
    expect(within(carts).getByText('Waiting · step 2')).toBeInTheDocument();
    expect(within(carts).getAllByText('Customer').length).toBeGreaterThan(0); // name needs customers.view (null → "Customer")

    expect(screen.getByRole('switch', { name: 'Skip Risky customers' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Quiet hours' })).toBeDisabled();
    expect(screen.getByText('No messages 9 PM – 9 AM')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'One coupon per phone' })).not.toBeChecked();
    expect(screen.getByRole('link', { name: 'COMEBACK10' })).toHaveAttribute('href', '/marketing/coupons/CP1');
  });

  it('Save sends the whole settings with the new wait; Send test posts the step', async () => {
    const fetchMock = signedIn('owner', {
      ...automationRoutes(),
      'PATCH /stores/S1/automations/A1': jsonResponse(200, { data: { ...recoveryDetail(), revision: 2 } }),
      'POST /stores/S1/automations/A1/test-message': jsonResponse(202, { data: { to_masked: '+880 17•• •••123' } }),
    });
    renderApp(<AppRoutes />, { route: '/marketing/automations/checkout-recovery' });
    await userEvent.selectOptions(await screen.findByLabelText('Wait before step 1', {}, SLOW), '60');
    await userEvent.click(screen.getByRole('switch', { name: 'Skip Risky customers' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/automations/A1').some(([, i]) => i.method === 'PATCH')).toBe(true));
    const body = JSON.parse(String(callsTo(fetchMock, '/stores/S1/automations/A1').find(([, i]) => i.method === 'PATCH')![1].body));
    expect(body.settings).toMatchObject({ delay_minutes: 60, skip_risky: false, wait_hours: 24, exit_days: 3 });
    expect(body.settings.step2.coupon_id).toBe('CP1');

    await userEvent.click(screen.getByRole('button', { name: 'Send test' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Test step 2' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/automations/A1/test-message')).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, '/stores/S1/automations/A1/test-message')[0]![1].body))).toEqual({ step: 2 });
  });

  it('not set up: offers Set up flow', async () => {
    const fetchMock = signedIn('owner', { ...automationRoutes({ list: [] }), 'POST /stores/S1/automations': jsonResponse(201, { data: recoveryDetail() }) });
    renderApp(<AppRoutes />, { route: '/marketing/automations/checkout-recovery' });
    await userEvent.click(await screen.findByRole('button', { name: 'Set up flow' }, SLOW));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/automations').some(([, i]) => i.method === 'POST')).toBe(true));
  });
});

describe('Run log', () => {
  it('filters by status and automation; a row expands to its steps', async () => {
    const fetchMock = signedIn('owner', automationRoutes());
    renderApp(<AppRoutes />, { route: '/marketing/automations/runs' });
    const row = await screen.findByRole('button', { name: /Silk Saree · Red · Low stock alert/ }, SLOW);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByRole('list', { name: 'Steps' })).getByText('Emailed 2 team members')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Failed' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/automation-runs').some(([url]) => new URL(url, 'http://x').searchParams.get('filter[status]') === 'failed')).toBe(true));
    await userEvent.selectOptions(screen.getByLabelText('Automation'), 'A1');
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/automation-runs').some(([url]) => new URL(url, 'http://x').searchParams.get('filter[automation_id]') === 'A1')).toBe(true));
  });

  it('empty state', async () => {
    signedIn('owner', automationRoutes({ runs: [] }));
    renderApp(<AppRoutes />, { route: '/marketing/automations/runs' });
    expect(await screen.findByText('No runs yet', {}, SLOW)).toBeInTheDocument();
  });
});

describe('Marketing overview (8.6 items unhidden)', () => {
  it('Automations tab with count, Carts recovered tile, Cart recovery series and quick card', async () => {
    signedIn('owner', automationRoutes());
    renderApp(<AppRoutes />, { route: '/marketing' });
    expect(await screen.findByRole('tab', { name: /Automations\s*3/ }, SLOW)).toBeInTheDocument();
    const kpis = await screen.findByRole('region', { name: 'Marketing summary' }, SLOW);
    expect(within(kpis).getByText('Carts recovered')).toBeInTheDocument();
    expect(within(kpis).getByText('৳ 92,400 won back')).toBeInTheDocument();
    expect(screen.getAllByText('Cart recovery').length).toBeGreaterThan(0);
    expect(screen.getByText('Abandoned cart recovery')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up flow' })).toHaveAttribute('href', '/marketing/automations/checkout-recovery');
    for (const hidden of ['Return on spend', 'WhatsApp broadcast']) expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    expect(screen.queryByText(/Best week yet/)).not.toBeInTheDocument();
  });
});
