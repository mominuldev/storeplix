import type { AdminAiCredits, AiCreditLedgerEntry, PlatformRole } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { adminSession, cursorList, emptyList, jsonResponse, mockApi, on, renderApp, tenant, type Call } from '../test/utils';
import { aiAdjustPreview, ledgerDetail, signed } from './format';

const credits = (overrides: { bonus?: number; used?: number; limit?: number | null } = {}): AdminAiCredits => {
  const limit = overrides.limit === undefined ? 300 : overrides.limit;
  const used = overrides.used ?? 120;
  const bonus = overrides.bonus ?? 50;
  const remaining = limit === null ? null : Math.max(0, limit - used);
  return {
    tenant_id: 'T1',
    credits: {
      allowance: { limit, used, remaining, resets_at: '2026-11-30T18:00:00Z' },
      bonus,
      available: (remaining ?? 0) + bonus,
      costs: { product_description: 1, photo_edit: 2 },
    },
    last_adjusted_at: '2026-11-20T04:00:00Z',
  };
};

const entry = (overrides: Partial<AiCreditLedgerEntry> = {}): AiCreditLedgerEntry => ({
  id: 'L1',
  type: 'admin_adjust',
  source: null,
  credits: 50,
  bonus_after: 50,
  period: '2026-11',
  generation: null,
  reason: 'Promotion: bonus AI credits from Store Plix.',
  created_at: '2026-11-20T04:00:00Z',
  ...overrides,
});

describe('PHASE-8-9D AI credit helpers', () => {
  it('aiAdjustPreview validates 1…100,000 and never goes below 0', () => {
    expect(aiAdjustPreview(50, 'grant', '100')).toEqual({ delta: 100, after: 150, error: null });
    expect(aiAdjustPreview(50, 'deduct', '80')).toMatchObject({ delta: -80, after: -30, error: 'Can’t go below 0 — the shop has 50 bonus credits.' });
    expect(aiAdjustPreview(50, 'grant', '0').error).not.toBeNull();
    expect(aiAdjustPreview(50, 'grant', '100001').error).not.toBeNull();
    expect(aiAdjustPreview(50, 'grant', '1,00,000').error).toBeNull();
    expect(aiAdjustPreview(50, 'grant', '2.5').error).toBe('Enter a whole number of credits.');
    expect(aiAdjustPreview(50, 'grant', '')).toEqual({ delta: 0, after: 50, error: null });
    expect(signed(-2)).toBe('−2');
  });

  it('ledgerDetail shows the reason or the AI tool', () => {
    expect(ledgerDetail(entry())).toBe('Promotion: bonus AI credits from Store Plix.');
    expect(ledgerDetail(entry({ type: 'consume', reason: null, generation: { id: 'G1', kind: 'photo_edit' } }))).toBe('Photo edit');
    expect(ledgerDetail(entry({ type: 'refund', reason: null, generation: { id: 'G1', kind: 'product_description' } }))).toBe('Product description · failed or undone');
    expect(ledgerDetail(entry({ type: 'consume', reason: null, generation: null }))).toBe('—');
  });
});

describe('merchant AI credits (§10.4)', () => {
  let keys: string[];
  beforeEach(() => {
    keys = [];
  });
  afterEach(() => vi.restoreAllMocks());

  function aiApi(
    role: PlatformRole,
    {
      adjust,
      get = () => jsonResponse(200, { data: credits() }),
      ledger = () =>
        cursorList([
          entry(),
          entry({ id: 'L2', type: 'consume', source: 'allowance', credits: -2, bonus_after: 0, reason: null, generation: { id: 'G1', kind: 'photo_edit' }, created_at: '2026-11-18T04:00:00Z' }),
        ]),
    }: { adjust?: (c: Call) => Response; get?: () => Response; ledger?: (c: Call) => Response } = {},
  ) {
    return mockApi(
      [
        on('GET', '/admin/tenants/T1', () => jsonResponse(200, { data: tenant({ usage: [{ key: 'orders_per_month', used: 40, limit: 100 }, { key: 'ai_credits_per_month', used: 120, limit: 300 }] }) })),
        on('GET', '/admin/tenants/T1/ai-credits', get),
        on('GET', '/admin/tenants/T1/ai-credits/ledger', ledger),
        on('POST', '/admin/tenants/T1/ai-credits/adjust', (c) => {
          keys.push(c.headers['Idempotency-Key'] ?? '');
          return adjust ? adjust(c) : jsonResponse(200, { data: credits({ bonus: 50 + (c.body as { credits: number }).credits }) });
        }),
        on('GET', '/admin/tenants/T1/sms-credits', () => jsonResponse(404, { error: { code: 'not_found', message: 'Not found.' } })),
        on('GET', '/admin/tenants/T1/sms-credits/ledger', () => cursorList()),
        on('GET', '/admin/tenants/T1/invoices', () => emptyList()),
        on('GET', '/admin/tenants/T1/audit-logs', () => cursorList()),
      ],
      { session: adminSession(role) },
    );
  }

  it('overview usage row shows allowance and bonus, with Adjust AI credits for manage_billing', async () => {
    aiApi('billing');
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    expect(await screen.findByText('AI credits')).toBeInTheDocument();
    expect(await screen.findByText('120 / 300')).toBeInTheDocument();
    expect(await screen.findByText(/^40% of plan allowance used · 50 bonus credits · resets/)).toBeInTheDocument();
    // The limit key is rendered by the AI row only, never as a raw generic usage row.
    expect(screen.queryByText('ai_credits_per_month')).toBeNull();
    expect(screen.getByRole('button', { name: 'Adjust AI credits' })).toBeEnabled();
  });

  it('billing card renders available, allowance, bonus and the ledger', async () => {
    aiApi('super_admin');
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    const card = (await screen.findByRole('heading', { name: 'AI credits' })).closest('div.overflow-hidden') as HTMLElement;
    expect(await within(card).findByText('Staff adjustment')).toBeInTheDocument();
    expect(within(card).getByText('Available now').nextElementSibling).toHaveTextContent('230');
    expect(within(card).getByText('Plan allowance this month').nextElementSibling).toHaveTextContent('120 / 300');
    expect(within(card).getByText(/180 left · resets/)).toBeInTheDocument();
    expect(within(card).getByText('Bonus credits').nextElementSibling).toHaveTextContent('50');
    expect(within(card).getByText('Promotion: bonus AI credits from Store Plix.')).toBeInTheDocument();
    expect(within(card).getByText('Photo edit')).toBeInTheDocument();
    expect(within(card).getByText('−2')).toBeInTheDocument();
    expect(within(card).getByText('Plan allowance')).toBeInTheDocument();
  });

  it.each<PlatformRole>(['support', 'read_only'])('%s sees the card and ledger but no Adjust AI credits', async (role) => {
    aiApi(role);
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    expect(await screen.findByText('Promotion: bonus AI credits from Store Plix.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adjust AI credits' })).toBeNull();
  });

  it('shows the error state with retry, and the empty ledger state', async () => {
    let fail = true;
    aiApi('super_admin', {
      get: () => (fail ? jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) : jsonResponse(200, { data: credits() })),
      ledger: () => cursorList(),
    });
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    expect(await screen.findByText('We couldn’t load AI credits')).toBeInTheDocument();
    expect(screen.getByText('No AI credit history yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjust AI credits' })).toBeDisabled();
    fail = false;
    const error = screen.getByText('We couldn’t load AI credits').closest('div') as HTMLElement;
    await userEvent.click(within(error.parentElement as HTMLElement).getByRole('button', { name: /try again|retry/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adjust AI credits' })).toBeEnabled());
  });

  it('ledger loads more with the next cursor', async () => {
    const api = aiApi('read_only', {
      ledger: (c) =>
        c.url.searchParams.get('cursor') === 'C2'
          ? cursorList([entry({ id: 'L9', reason: 'Older adjustment from last month' })])
          : jsonResponse(200, { data: [entry()], meta: { next_cursor: 'C2', prev_cursor: null, per_page: 50 } }),
    });
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    await screen.findByText('Promotion: bonus AI credits from Store Plix.');
    const card = screen.getByRole('heading', { name: 'AI credits' }).closest('div.overflow-hidden') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Older adjustment from last month')).toBeInTheDocument();
    expect(screen.getByText('Promotion: bonus AI credits from Store Plix.')).toBeInTheDocument();
    const calls = api.find('GET', '/admin/tenants/T1/ai-credits/ledger');
    expect(calls.at(-1)!.url.searchParams.get('cursor')).toBe('C2');
    await waitFor(() => expect(within(card).queryByRole('button', { name: 'Load more' })).toBeNull());
  });

  it('grant: validation, preview, payload, toast and one Idempotency-Key per open', async () => {
    const api = aiApi('super_admin');
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    await screen.findByText('Promotion: bonus AI credits from Store Plix.');
    await userEvent.click(screen.getByRole('button', { name: 'Adjust AI credits' }));
    const dialog = await screen.findByRole('dialog', { name: 'Adjust AI credits' });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByText('Enter the number of credits.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a reason of at least 5 characters')).toBeInTheDocument();
    expect(api.find('POST', '/admin/tenants/T1/ai-credits/adjust')).toHaveLength(0);

    await userEvent.type(within(dialog).getByLabelText('Credits to grant'), '100');
    expect(within(dialog).getByTestId('ai-adjust-delta')).toHaveTextContent('+100');
    expect(within(dialog).getByText('50 → 150')).toBeInTheDocument();
    expect(within(dialog).getByText('230 → 330')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: /Promotion/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.find('POST', '/admin/tenants/T1/ai-credits/adjust')).toHaveLength(1));
    expect(api.find('POST', '/admin/tenants/T1/ai-credits/adjust')[0]!.body).toEqual({ credits: 100, reason: 'Promotion: bonus AI credits from Store Plix.' });
    expect(await screen.findByText('Granted 100 AI credits · bonus 150')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Adjust AI credits' })).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Adjust AI credits' }));
    const again = await screen.findByRole('dialog', { name: 'Adjust AI credits' });
    await userEvent.type(within(again).getByLabelText('Credits to grant'), '5');
    await userEvent.type(within(again).getByLabelText(/Reason shown to the merchant/), 'Goodwill bonus');
    await userEvent.click(within(again).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('deduct below 0 disables Apply; a 422 ai_credits_insufficient shows inline and a retry reuses the key', async () => {
    let calls = 0;
    aiApi('billing', {
      adjust: () => {
        calls += 1;
        return jsonResponse(422, { error: { code: 'ai_credits_insufficient', message: 'Insufficient' } });
      },
    });
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    await screen.findByText('Promotion: bonus AI credits from Store Plix.');
    await userEvent.click(screen.getByRole('button', { name: 'Adjust AI credits' }));
    const dialog = await screen.findByRole('dialog', { name: 'Adjust AI credits' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Deduct credits/ }));
    const field = within(dialog).getByLabelText('Credits to deduct');
    await userEvent.type(field, '80');
    expect(within(dialog).getByText('Can’t go below 0 — the shop has 50 bonus credits.')).toBeInTheDocument();
    expect(within(dialog).getByTestId('ai-adjust-delta')).toHaveTextContent('−80');
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, '20');
    await userEvent.type(within(dialog).getByLabelText(/Reason shown to the merchant/), 'Correction of an earlier grant');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Can’t go below 0 — the shop has 50 bonus credits. Refresh');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(keys[0]).toBe(keys[1]);
  });

  it('a generic error shows the API message inline', async () => {
    aiApi('super_admin', { adjust: () => jsonResponse(403, { error: { code: 'forbidden', message: 'You can’t adjust credits.' } }) });
    renderApp(<AppRoutes />, { route: '/merchants/T1?tab=billing' });
    await screen.findByText('Promotion: bonus AI credits from Store Plix.');
    await userEvent.click(screen.getByRole('button', { name: 'Adjust AI credits' }));
    const dialog = await screen.findByRole('dialog', { name: 'Adjust AI credits' });
    await userEvent.type(within(dialog).getByLabelText('Credits to grant'), '10');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Service issue/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  });
});
