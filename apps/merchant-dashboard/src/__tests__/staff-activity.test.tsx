import type { AuditLog } from '@storeplix/types';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { auditActivityText, mergeRecentActivity } from '../lib/audit';
import { callsTo, jsonResponse, member, renderApp, signedIn } from '../test/utils';

const log = (over: Partial<AuditLog>): AuditLog => ({
  id: 'L1',
  action: 'staff.invited',
  actor: { type: 'user', id: 'U1', name: 'Rafiqul Alam' },
  subject: null,
  meta: {},
  ip: null,
  user_agent: null,
  created_at: '2026-11-20T10:00:00Z',
  ...over,
});

const supportRow = log({
  id: 'L2',
  action: 'billing.period_extended',
  actor: { type: 'platform_user', id: null, name: 'Store Plix support' },
  created_at: '2026-11-21T10:00:00Z',
});

// P8-QA-1: Store Plix support actions on the shop appear in the merchant's activity card.
describe('Staff page — recent activity includes Store Plix support', () => {
  it('lists a platform_user row as "Store Plix support" with readable action text', async () => {
    const api = signedIn('owner', {
      'GET /staff': jsonResponse(200, { data: [member({ id: 'O', name: 'Rafiqul Alam', role: 'owner', is_you: true })], meta: { seats_used: 0, seats_limit: 5 } }),
      'GET /audit-logs': jsonResponse(200, { data: [log({}), supportRow], meta: { current_page: 1, per_page: 5, total: 2, last_page: 1 } }),
    });
    renderApp(<AppRoutes />, { route: '/staff' });

    const item = (await screen.findByText('extended your billing period')).closest('li');
    expect(item).toHaveTextContent('Store Plix support extended your billing period');
    expect(screen.getByText('invited a team member')).toBeInTheDocument();
    // Newest first across both queries; rows are deduped by id.
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('Store Plix support') || li.textContent?.includes('invited a team member'));
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Store Plix support');

    const queries = callsTo(api, '/audit-logs').map(([u]) => new URL(u, 'http://localhost').searchParams);
    expect(queries.some((q) => q.get('filter[actor_type]') === 'platform_user')).toBe(true);
    expect(queries.some((q) => q.get('filter[action]') === 'staff.*')).toBe(true);
  });
});

describe('audit helpers', () => {
  it('has text for every Phase 8.1 support action and falls back to the raw action', () => {
    for (const action of [
      'billing.period_extended',
      'subscription.plan_changed',
      'billing.invoice_voided',
      'billing.manual_payment',
      'billing.invoice_resent',
      'tenant.suspended',
      'tenant.reactivated',
      'admin.impersonation_started',
      'admin.impersonation_ended',
    ]) {
      expect(auditActivityText(action)).not.toBe(action);
    }
    expect(auditActivityText('something.new')).toBe('something.new');
  });

  it('merges newest-first, dedupes and caps', () => {
    const a = log({ id: 'A', created_at: '2026-11-01T00:00:00Z' });
    const b = log({ id: 'B', created_at: '2026-11-03T00:00:00Z' });
    const c = log({ id: 'C', created_at: '2026-11-02T00:00:00Z' });
    expect(mergeRecentActivity([[b, a], [c, b], undefined], 2).map((e) => e.id)).toEqual(['B', 'C']);
  });
});
