import type { AdminAuditEntry } from '@storeplix/types';
import { Avatar, Button, cn, copyText } from '@storeplix/ui';
import { ChevronDown, ChevronRight, Eye } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { formatDate, formatTime } from '../lib/format';

const actionLabels: Record<string, string> = {
  'admin.login': 'Signed in',
  'admin.login_failed': 'Sign-in failed',
  'admin.locked': 'Account locked',
  'admin.impersonation_started': 'Impersonated shop',
  'admin.impersonation_ended': 'Impersonation ended',
  'admin.ip_blocked': 'Blocked by IP allowlist',
  'tenant.suspended': 'Suspended shop',
  'tenant.reactivated': 'Reactivated shop',
  'billing.manual_payment': 'Marked invoice paid',
  'billing.invoice_voided': 'Voided invoice',
  'billing.invoice_resent': 'Resent invoice',
  'subscription.extended': 'Extended subscription',
  'subscription.plan_comped': 'Changed plan',
  'subscription.change_scheduled': 'Scheduled plan change',
};

/** `billing.invoice_voided` → "Voided invoice" (known) or "Billing · invoice voided". */
export function actionLabel(action: string): string {
  if (actionLabels[action]) return actionLabels[action];
  const [scope, ...rest] = action.split('.');
  const what = rest.join(' ').replace(/_/g, ' ');
  return what ? `${scope!.charAt(0).toUpperCase()}${scope!.slice(1).replace(/_/g, ' ')} · ${what}` : action;
}

export const isImpersonationEntry = (e: AdminAuditEntry) => !!e.impersonation_id || e.action.startsWith('admin.impersonation');

function actorName(e: AdminAuditEntry): { name: string; sub: string } {
  if (e.actor.type === 'system') return { name: 'System', sub: 'Automation' };
  if (e.actor.type === 'platform_user')
    return {
      name: e.actor.name ?? 'Staff',
      sub: e.actor.email ?? 'Platform staff',
    };
  return {
    name: e.actor.name ?? 'Merchant user',
    sub: e.actor.email ?? 'Merchant',
  };
}

// Audit log 39:16118 (§7.1): Time · Actor · Action · Target · IP · Reason · chevron. Impersonation rows are amber
// (warning-bg). The expanded row shows event id, IP, user agent, reason and the `meta` JSON with Copy JSON; the hash
// chain, before/after diff and "Open ticket" are hidden (Q100). `showTenant={false}` inside a merchant's tab.
export function AuditTable({
  rows,
  state,
  footer,
  showTenant = true,
}: {
  rows: AdminAuditEntry[];
  state?: ReactNode;
  footer?: ReactNode;
  showTenant?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-left">
        <caption className="sr-only">Audit log</caption>
        <thead>
          <tr className="border-b border-border-default bg-surface-subtle text-caption font-medium tracking-[0.02em] text-text-muted uppercase">
            <th scope="col" className="w-[120px] px-4 py-2.5 font-medium">
              Time
            </th>
            <th scope="col" className="w-[190px] px-3 py-2.5 font-medium">
              Actor
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Action
            </th>
            {showTenant && (
              <th scope="col" className="w-[170px] px-3 py-2.5 font-medium">
                Target
              </th>
            )}
            <th scope="col" className="w-[120px] px-3 py-2.5 font-medium">
              IP
            </th>
            <th scope="col" className="w-[220px] px-3 py-2.5 font-medium">
              Reason
            </th>
            <th scope="col" className="w-10 px-3 py-2.5">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {state ? (
            <tr>
              <td colSpan={showTenant ? 7 : 6}>{state}</td>
            </tr>
          ) : (
            rows.map((e) => {
              const expanded = open === e.id;
              const imp = isImpersonationEntry(e);
              const actor = actorName(e);
              return (
                <Fragment key={e.id}>
                  <tr className={cn('border-b border-border-default align-top', imp ? 'bg-warning-bg/60' : expanded && 'bg-brand-50/60')}>
                    <td className="px-4 py-3">
                      <span className="block text-body whitespace-nowrap text-text-primary">{formatDate(e.created_at)}</span>
                      <span className="block text-caption text-text-muted tabular-nums">{formatTime(e.created_at)}</span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={actor.name} size="sm" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-body font-medium text-text-primary">{actor.name}</span>
                          <span className="truncate text-caption text-text-muted">{actor.sub}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="block text-body font-medium text-text-primary">{actionLabel(e.action)}</span>
                      <span className="flex items-center gap-1.5 text-caption text-text-muted">
                        {imp && (
                          <span className="inline-flex items-center gap-1 font-medium text-warning">
                            <Eye aria-hidden className="size-3" /> Impersonation
                          </span>
                        )}
                        <code className="font-sans">{e.action}</code>
                      </span>
                    </td>
                    {showTenant && (
                      <td className="px-3 py-3">
                        {e.tenant ? (
                          <Link to={`/merchants/${e.tenant.id}`} className="flex min-w-0 flex-col hover:underline">
                            <span className="truncate text-body text-text-primary">{e.tenant.name}</span>
                            <span className="truncate text-caption text-text-muted">{e.tenant.slug}</span>
                          </Link>
                        ) : (
                          <span className="text-caption text-text-muted">Platform</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-3 text-body text-text-secondary tabular-nums">{e.ip ?? '—'}</td>
                    <td className="px-3 py-3 text-body text-text-secondary">
                      <span className="line-clamp-2">{e.reason ?? '—'}</span>
                    </td>
                    <td className="px-2 py-3">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={expanded ? 'Hide details' : 'Show details'}
                        onClick={() => setOpen(expanded ? null : e.id)}
                        className="rounded-md p-1 text-text-muted outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
                      >
                        {expanded ? <ChevronDown aria-hidden className="size-4 text-brand-600" /> : <ChevronRight aria-hidden className="size-4" />}
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-b border-border-default bg-surface-card">
                      <td colSpan={showTenant ? 7 : 6} className="px-4 py-4">
                        <AuditDetails entry={e} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
      {footer}
    </div>
  );
}

function AuditDetails({ entry }: { entry: AdminAuditEntry }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(entry.meta ?? {}, null, 2);
  const facts: [string, string | null][] = [
    ['Event ID', entry.id],
    ['IP', entry.ip],
    ['User agent', entry.user_agent],
    ['Reason', entry.reason],
    ['Subject', entry.subject ? `${entry.subject.type} · ${entry.subject.id}` : null],
    ['Impersonation', entry.impersonation_id],
  ];
  return (
    <div className="grid gap-5 md:grid-cols-[260px_minmax(0,1fr)]">
      <dl className="flex flex-col gap-3">
        {facts
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <dt className="text-caption text-text-muted">{k}</dt>
              <dd className="text-body break-all text-text-primary">{v}</dd>
            </div>
          ))}
      </dl>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-body font-semibold text-text-primary">Details (meta)</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              if (await copyText(JSON.stringify({ ...entry }, null, 2))) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
        </div>
        <pre className="max-h-72 overflow-auto rounded-lg border border-border-default bg-surface-subtle p-3 text-caption leading-5 text-text-primary">
          {json}
        </pre>
      </div>
    </div>
  );
}
