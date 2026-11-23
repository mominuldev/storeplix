import type { AuditLog } from '@storeplix/types';

/** Shown for Storeplix staff actions (S81: the API never exposes the staff member's name, email or id to merchants). */
export const PLATFORM_ACTOR_LABEL = 'Store Plix support';

/** Who did it, for the merchant activity log. `platform_user` (Phase 8.1) → "Store Plix support"; system/null → Storeplix. */
export function auditActorName(entry: Pick<AuditLog, 'actor'>): string {
  const actor = entry.actor;
  if (actor?.type === 'platform_user') return PLATFORM_ACTOR_LABEL;
  return actor?.name ?? 'Storeplix';
}

/** Human text after the actor's name in the activity card. Unknown actions fall back to the raw action name. */
const activityText: Record<string, string> = {
  'staff.invited': 'invited a team member',
  'staff.invitation_resent': 'resent an invitation',
  'staff.invitation_revoked': 'cancelled an invitation',
  'staff.joined': 'joined the team',
  'staff.role_changed': 'changed a team member’s role',
  'staff.removed': 'removed a team member',
  'staff.left': 'left the team',
  // Phase 8.1 (P8-QA-1): Store Plix support actions on the shop.
  'billing.period_extended': 'extended your billing period',
  'subscription.plan_changed': 'changed your plan',
  'subscription.change_scheduled': 'scheduled a plan change',
  'billing.invoice_voided': 'voided an invoice',
  'billing.manual_payment': 'recorded a payment on an invoice',
  'billing.invoice_resent': 'resent an invoice',
  'tenant.suspended': 'suspended your shop',
  'tenant.reactivated': 'reactivated your shop',
  'domain.suspended': 'suspended a domain',
  'domain.reinstated': 'reinstated a domain',
  'admin.impersonation_started': 'started a support session in your dashboard',
  'admin.impersonation_ended': 'ended a support session',
};

export function auditActivityText(action: string): string {
  return activityText[action] ?? action;
}

/** Merges several newest-first audit pages into one newest-first list (deduped by id), capped at `limit`. */
export function mergeRecentActivity(lists: ReadonlyArray<ReadonlyArray<AuditLog> | undefined>, limit: number): AuditLog[] {
  const byId = new Map<string, AuditLog>();
  for (const list of lists) for (const entry of list ?? []) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1)).slice(0, limit);
}
