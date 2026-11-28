import { SMS_MESSAGE_GROUP_LABELS, type SmsProvider, type SmsProviderOverview } from '@storeplix/types';
import { Badge, Button, buttonVariants, cn, formatBdt, formatCount, Input, parseMoney, moneyToInput, Toggle } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, PlugZap, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, LoadingRows } from '../../components/States';
import { api } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { relativeDay } from '../../sms/format';
import { ConfigureDrawer } from './ConfigureDrawer';
import { ProviderTestResultCard, RemoveProviderDialog } from './dialogs';
import { balanceStatusMeta, errorCodeLabel, healthMeta, providerInitials, recentResultMeta, roleMeta, typeLabel } from './format';
import { ManageDrawer } from './ManageDrawer';
import { platformSmsKeys, smsErrorText, useProviderOverview } from './queries';
import { InlineAlert, LockedField, ReadOnlyField, SectionCard, SubHeader, TestSmsDialog } from './ui';

// Provider tab (PHASE-8-9B §11.1): Figma 2098:8460 (configured) and 2111:9331 (not configured). Cards: SMS gateway
// (primary tile + failover slot, API credentials with Rotate → Manage drawer, sender IDs), Gateway balance,
// Recent errors; drafts/inactive in a compact list. The Figma "Discard / Save changes" footer is dropped: edits
// happen in the Manage drawer (§18).

type Overlay =
  | { kind: 'configure'; role: 'primary' | 'failover' }
  | { kind: 'manage'; id: string; rotate?: boolean }
  | { kind: 'remove'; provider: SmsProvider }
  | { kind: 'test'; provider: SmsProvider }
  | null;

export function ProviderTab({ onOpenLog }: { onOpenLog: (status?: 'failed') => void }) {
  const query = useProviderOverview();
  const [overlay, setOverlay] = useState<Overlay>(null);

  if (query.isPending) return <LoadingRows label="Loading SMS provider" rows={6} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const o = query.data;

  return (
    <div className="flex flex-col gap-5">
      {o.source === 'none' && <NotConfigured overview={o} onConfigure={() => setOverlay({ kind: 'configure', role: 'primary' })} />}
      {o.source === 'environment' && <EnvironmentCard overview={o} onConfigure={() => setOverlay({ kind: 'configure', role: 'primary' })} />}
      {o.primary && <GatewayCard overview={o} primary={o.primary} onOverlay={setOverlay} />}
      {o.primary && <BalanceCard provider={o.primary} />}
      {o.failover && o.failover.balance.status !== 'unsupported' && <BalanceCard provider={o.failover} />}
      {o.source !== 'none' && <RecentErrors overview={o} onOpenLog={() => onOpenLog('failed')} />}
      {o.others.length > 0 && <OthersCard providers={o.others} onOverlay={setOverlay} />}

      {overlay?.kind === 'configure' && <ConfigureDrawer role={overlay.role} overview={o} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'manage' && <ManageDrawer providerId={overlay.id} startRotate={overlay.rotate} overview={o} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'remove' && <RemoveProviderDialog provider={overlay.provider} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'test' && (
        <TestSmsDialog
          title={`Send a test SMS through ${overlay.provider.name}`}
          onClose={() => setOverlay(null)}
          send={(phone) => api.admin.platformSms.providers.test(overlay.provider.id, { phone })}
          renderResult={(r) => <ProviderTestResultCard result={r} providerName={overlay.provider.name} />}
        />
      )}
    </div>
  );
}

const WAIT_NOTE: Record<string, string> = {
  registration: 'Sent when a provider is active, if still inside 30 minutes; codes give up after 5 minutes.',
  billing: 'Sent on activation if still inside 30 minutes, oldest first.',
  security: 'Codes fail after 5 minutes — merchants ask for a new one.',
  promotional: 'Broadcasts stay paused until a provider with a promotional mask is active.',
  shop: 'Shop SMS keep their own retries.',
};

function NotConfigured({ overview, onConfigure }: { overview: SmsProviderOverview; onConfigure: () => void }) {
  return (
    <>
      <InlineAlert tone="danger">
        <p className="font-semibold text-danger">No SMS provider — sign-in codes will fail</p>
        <p className="text-text-secondary">Merchants who sign in with a phone code can’t get in, and new shops can’t verify their phone. Platform SMS are queued; promotional SMS are paused.</p>
      </InlineAlert>
      <section className="flex flex-col items-center gap-4 rounded-card border border-border-default bg-surface-card px-6 py-10 text-center shadow-elevation-1">
        <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <PlugZap className="size-6" />
        </span>
        <div className="flex max-w-md flex-col gap-1.5">
          <h2 className="text-heading text-text-primary">Set up an SMS provider</h2>
          <p className="text-body text-text-secondary">
            Storeplix texts merchants for sign-up, billing and sign-in codes through a BTRC-approved aggregator such as REVE SMS. Add one to start sending.
          </p>
        </div>
        <Button onClick={onConfigure}>Configure provider</Button>
        <ol className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-caption text-text-secondary">
          {['An aggregator account', 'API key and secret', 'An approved sender ID'].map((t, i) => (
            <li key={t} className="flex items-center gap-1.5">
              <span className="flex size-5 items-center justify-center rounded-full bg-surface-subtle text-text-muted">{i + 1}</span>
              {t}
            </li>
          ))}
        </ol>
      </section>
      <SectionCard
        title="What’s waiting"
        description="Platform SMS queued or failed in the last 24 hours"
        actions={
          <Badge size="sm" tone="danger">
            Paused
          </Badge>
        }
      >
        <div className="overflow-x-auto rounded-lg border border-border-default">
          <table className="w-full min-w-[520px] text-left text-body">
            <thead className="bg-surface-subtle text-caption text-text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">MESSAGE TYPE</th>
                <th className="px-4 py-2.5 font-medium">WAITING</th>
                <th className="px-4 py-2.5 font-medium">WHAT HAPPENS</th>
              </tr>
            </thead>
            <tbody>
              {overview.waiting.length === 0 ? (
                <tr className="border-t border-border-default">
                  <td colSpan={3} className="px-4 py-3 text-text-muted">
                    Nothing is waiting.
                  </td>
                </tr>
              ) : (
                overview.waiting.map((w) => (
                  <tr key={w.group} className="border-t border-border-default">
                    <td className="px-4 py-3 text-text-primary">{SMS_MESSAGE_GROUP_LABELS[w.group]}</td>
                    <td className="px-4 py-3">
                      <span className="text-text-primary">{formatCount(w.queued)} queued</span>
                      {w.failed_24h > 0 && <span className="block text-caption text-danger">{formatCount(w.failed_24h)} failed</span>}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{WAIT_NOTE[w.group]}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-caption text-text-muted">Platform SMS wait 30 minutes, sign-in codes 5 minutes, then fail.</p>
      </SectionCard>
    </>
  );
}

function EnvironmentCard({ overview, onConfigure }: { overview: SmsProviderOverview; onConfigure: () => void }) {
  const env = overview.environment;
  return (
    <SectionCard
      title="REVE SMS (server environment)"
      description="Every SMS goes through the REVE account set in the server environment. Move it into Store Plix to rotate keys and add a failover."
      actions={
        <>
          <Badge size="sm" tone="info">
            Read-only
          </Badge>
          <Button size="sm" onClick={onConfigure}>
            Configure provider
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <ReadOnlyField label="Caller ID" value={env?.caller_id ?? '—'} />
        <ReadOnlyField label="Driver" value={env?.driver === 'revesms' ? 'REVE SMS' : env?.driver === 'log' ? 'Log only (development)' : env?.driver === 'fake' ? 'Fake (tests)' : '—'} />
        {Object.entries(env?.credentials_hint ?? {}).map(([k, hint]) => (
          <LockedField key={k} label={k === 'api_key' ? 'API key' : k === 'secret_key' ? 'Secret key' : k} hint={hint} />
        ))}
      </div>
    </SectionCard>
  );
}

function ProviderTile({ provider, slot, onManage }: { provider: SmsProvider; slot: 'primary' | 'failover'; onManage: () => void }) {
  const health = healthMeta[provider.health];
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-border-default p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-brand-600 text-caption font-medium text-text-inverse">
          {providerInitials(provider.name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-body font-semibold text-text-primary">{provider.name}</p>
          <p className="text-caption text-text-muted">
            {slot === 'primary' ? 'Primary route' : `Failover · used after ${provider.failover_after_failures} failed sends or a ${provider.failover_timeout_seconds} s timeout`}
          </p>
        </div>
        <Badge size="sm" tone={provider.health === 'failed_over' || provider.health === 'failing' ? health.tone : 'success'}>
          {provider.health === 'failed_over' || provider.health === 'failing' ? health.label : 'Active'}
        </Badge>
      </div>
      <div className="flex items-center gap-2 rounded-md bg-surface-subtle py-2 pr-2 pl-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-caption">
          <p className="truncate font-medium text-text-primary">
            {[provider.settings.account_id ? `Account ${provider.settings.account_id}` : null, hostOf(provider.settings.base_url)].filter(Boolean).join(' · ')}
          </p>
          <p className="text-text-muted">
            {provider.accepted_rate_24h !== null ? `${provider.accepted_rate_24h}% accepted by gateway (24 h)` : 'Nothing sent in 24 h'}
            {provider.last_sent_at ? ` · last send ${relativeDay(provider.last_sent_at)}` : ''}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onManage}>
          Manage
        </Button>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function GatewayCard({ overview, primary, onOverlay }: { overview: SmsProviderOverview; primary: SmsProvider; onOverlay: (o: Overlay) => void }) {
  const health = healthMeta[primary.health];
  const failover = overview.failover;
  const fields = Object.entries(primary.credentials_hint);
  return (
    <SectionCard
      title="SMS gateway"
      description="Every platform SMS — sign-up, billing, sign-in codes, announcements — and every shop SMS goes through these providers."
      actions={
        <>
          <Badge size="sm" tone={health.tone}>
            {health.label}
          </Badge>
          <Button size="sm" variant="secondary" onClick={() => onOverlay({ kind: 'test', provider: primary })}>
            Send test SMS
          </Button>
        </>
      }
    >
      {overview.failover_active && failover && (
        <InlineAlert tone="warning">SMS are going through {failover.name} because {primary.name} is failing. They switch back after 5 minutes without errors.</InlineAlert>
      )}
      <div className="flex flex-col gap-4 md:flex-row">
        <ProviderTile provider={primary} slot="primary" onManage={() => onOverlay({ kind: 'manage', id: primary.id })} />
        {failover ? (
          <ProviderTile provider={failover} slot="failover" onManage={() => onOverlay({ kind: 'manage', id: failover.id })} />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-dashed border-border-strong p-4">
            <div className="flex items-start gap-3">
              <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-surface-subtle text-caption font-medium text-text-muted">
                +
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-body font-semibold text-text-primary">Failover provider</p>
                <p className="text-caption text-text-muted">Optional. Used when {primary.name} fails {primary.failover_after_failures} sends in a row</p>
              </div>
              <Badge size="sm" tone="neutral">
                Not set
              </Badge>
            </div>
            <div className="flex items-center gap-2 rounded-md bg-surface-subtle py-2 pr-2 pl-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-caption">
                <p className="font-medium text-text-primary">No failover — if {primary.name} is down, SMS wait in the queue</p>
                <p className="text-text-muted">Retried for 30 min, then marked failed</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => onOverlay({ kind: 'configure', role: 'failover' })}>
                Add failover
              </Button>
            </div>
          </div>
        )}
      </div>

      <SubHeader title="API credentials" description="Stored encrypted. Never shown in full — Rotate replaces the value and logs who did it." />
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(([key, hint]) => (
          <LockedField
            key={key}
            label={key === 'api_key' ? 'API key' : key === 'secret_key' ? 'API secret' : key}
            hint={hint}
            action={
              <Button size="sm" variant="ghost" onClick={() => onOverlay({ kind: 'manage', id: primary.id, rotate: true })}>
                Rotate
              </Button>
            }
            caption={
              primary.credentials_rotated_at
                ? `Last rotated ${formatDate(primary.credentials_rotated_at)}${primary.credentials_rotated_by ? ` by ${primary.credentials_rotated_by.name}` : ''}`
                : 'Write-only'
            }
          />
        ))}
        <ReadOnlyField label="Account ID" value={primary.settings.account_id} />
        <ReadOnlyField label="API endpoint" value={primary.settings.base_url} caption="HTTPS only" />
      </div>

      <div aria-hidden className="h-px bg-border-default" />
      <SubHeader title="Sender IDs" description="Registered with BTRC through the provider. Promotional SMS must use the promotional mask." />
      <div className="grid gap-4 sm:grid-cols-2">
        <ReadOnlyField label="Default sender ID" value={primary.default_sender_id} caption="Registration, billing and sign-in messages" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-body font-medium text-text-primary">
            Promotional sender (mask)
            {primary.promotional_sender_status && (
              <Badge size="sm" tone={primary.promotional_sender_status === 'approved' ? 'success' : 'warning'}>
                {primary.promotional_sender_status === 'approved' ? 'Approved' : 'Pending BTRC'}
              </Badge>
            )}
          </span>
          <div className="flex min-h-10 items-center rounded-md border border-border-default px-3 py-2 text-body text-text-primary">{primary.promotional_sender_id ?? 'Not set'}</div>
          <p className="text-caption text-text-muted">Broadcasts only · 9 AM–9 PM</p>
        </div>
      </div>
    </SectionCard>
  );
}

/** Gateway balance card (2099:9108): ৳ amount, ~parts, days left, 7-day spend, Low pill + warning, threshold + alerts. */
export function BalanceCard({ provider }: { provider: SmsProvider }) {
  const toast = useToast();
  const qc = useQueryClient();
  const b = provider.balance;
  const [threshold, setThreshold] = useState(moneyToInput(b.low_threshold_paisa));
  const meta = balanceStatusMeta[b.status];
  const update = useMutation({
    mutationFn: (patch: { low_threshold_paisa?: number | null; alert_email?: boolean; alert_in_app?: boolean }) =>
      api.admin.platformSms.providers.update(provider.id, { revision: provider.revision, ...patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: platformSmsKeys.root });
      toast('Balance alert saved');
    },
  });
  const refresh = useMutation({
    mutationFn: () => api.admin.platformSms.providers.refreshBalance(provider.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: platformSmsKeys.root }),
  });
  const parsed = parseMoney(threshold);
  const thresholdError = parsed !== null && Number.isNaN(parsed) ? 'Enter an amount in taka.' : undefined;
  const portal = (() => {
    try {
      return new URL(provider.settings.base_url).origin;
    } catch {
      return null;
    }
  })();

  return (
    <SectionCard
      title={provider.role === 'failover' ? `Gateway balance · ${provider.name} (failover)` : 'Gateway balance'}
      description={`Prepaid balance at ${provider.name}. Balance is bought from the provider.`}
      actions={
        <>
          {meta && (
            <Badge size="sm" tone={meta.tone}>
              {meta.label}
            </Badge>
          )}
          {b.status !== 'unsupported' && (
            <Button size="sm" variant="ghost" leftIcon={<RefreshCw aria-hidden className="size-3.5" />} loading={refresh.isPending} onClick={() => refresh.mutate()}>
              Refresh
            </Button>
          )}
          {portal && provider.driver === 'revesms' && (
            <a href={portal} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}>
              Open {provider.name} portal <ExternalLink aria-hidden className="size-3.5" />
            </a>
          )}
        </>
      }
    >
      {b.status === 'unsupported' ? (
        <p className="text-body text-text-secondary">This provider doesn’t report a balance.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-6">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-heading-24 text-text-primary" data-testid="balance-amount">
                {b.amount_paisa !== null ? formatBdt(b.amount_paisa) : '—'}
              </p>
              <p className="text-caption text-text-muted">
                {[
                  b.approx_parts !== null ? `~${formatCount(b.approx_parts)} SMS parts` : null,
                  b.days_left !== null ? (b.days_left > 365 ? 'lasts over a year at the current pace' : `lasts ~${b.days_left} days at the current pace`) : null,
                  b.fetched_at ? `checked ${formatDateTime(b.fetched_at)}` : 'not read yet',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-caption text-text-muted">Spent last 7 days (estimate)</p>
              <p className="text-body font-medium text-text-primary">{formatBdt(b.spend_7d_paisa)}</p>
            </div>
          </div>
          {b.status === 'low' && (
            <InlineAlert tone="warning">
              Balance is below your {formatBdt(b.low_threshold_paisa)} alert. Sign-in codes stop when it reaches ৳ 0 — top up today.
            </InlineAlert>
          )}
          {b.status === 'error' && <InlineAlert tone="danger">We couldn’t read the balance on the last try. It is checked again every 15 minutes.</InlineAlert>}
          {refresh.isError && <InlineAlert tone="danger">{smsErrorText(refresh.error)}</InlineAlert>}
        </>
      )}
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input label="Alert me when the balance is below" leading="৳" value={threshold} onChange={(e) => setThreshold(e.target.value)} error={thresholdError} hint="Checked every 15 minutes" />
          </div>
          <Button
            variant="secondary"
            className="mb-6"
            disabled={!!thresholdError || parsed === b.low_threshold_paisa}
            loading={update.isPending && update.variables?.low_threshold_paisa !== undefined}
            onClick={() => update.mutate({ low_threshold_paisa: parsed })}
          >
            Save
          </Button>
        </div>
        <div className="flex flex-col gap-2.5">
          <p className="text-body font-medium text-text-primary">Who gets the alert</p>
          <div className="flex items-center justify-between gap-3 text-body text-text-primary">
            Email super admins
            <Toggle label="Email super admins" checked={b.alert_email} disabled={update.isPending} onChange={(v) => update.mutate({ alert_email: v })} />
          </div>
          <div className="flex items-center justify-between gap-3 text-body text-text-primary">
            Show a banner in Platform admin
            <Toggle label="Show a banner in Platform admin" checked={b.alert_in_app} disabled={update.isPending} onChange={(v) => update.mutate({ alert_in_app: v })} />
          </div>
        </div>
      </div>
      {update.isError && <InlineAlert tone="danger">{smsErrorText(update.error)}</InlineAlert>}
    </SectionCard>
  );
}

function RecentErrors({ overview, onOpenLog }: { overview: SmsProviderOverview; onOpenLog: () => void }) {
  const rows = overview.recent_errors;
  return (
    <SectionCard
      title="Recent errors"
      description="Last 24 h · failed or failed-over SMS · provider text with credentials removed"
      actions={
        <Button size="sm" variant="ghost" onClick={onOpenLog}>
          View SMS log
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="text-body text-text-secondary">No errors in the last 24 hours.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-default">
          <table className="w-full min-w-[640px] text-left text-body">
            <thead className="bg-surface-subtle text-caption text-text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">TIME</th>
                <th className="px-4 py-2.5 font-medium">ERROR</th>
                <th className="px-4 py-2.5 font-medium">MESSAGE TYPE</th>
                <th className="px-4 py-2.5 font-medium">PHONE</th>
                <th className="px-4 py-2.5 font-medium">RESULT</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const res = recentResultMeta[r.result];
                return (
                  <tr key={r.id} className="border-t border-border-default align-top">
                    <td className="px-4 py-3 whitespace-nowrap text-text-primary">{relativeDay(r.at)}</td>
                    <td className="px-4 py-3">
                      <span className="block text-text-primary">{errorCodeLabel[r.error_code] ?? r.error_code}</span>
                      {r.detail && <span className="block max-w-xs text-caption break-words text-text-muted">{r.detail}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="block text-text-primary">{typeLabel(r.type)}</span>
                      {r.provider && <span className="block text-caption text-text-muted">{r.provider.name}</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-text-primary">{r.to_masked}</td>
                    <td className="px-4 py-3">
                      <Badge size="sm" tone={res.tone}>
                        {res.label}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function OthersCard({ providers, onOverlay }: { providers: SmsProvider[]; onOverlay: (o: Overlay) => void }) {
  return (
    <SectionCard title="Other providers" description="Drafts and former providers. Nothing is sent through them.">
      <ul className="flex flex-col divide-y divide-border-default rounded-lg border border-border-default">
        {providers.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-caption font-medium text-brand-600">
              {providerInitials(p.name)}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2 text-body font-medium text-text-primary">
                {p.name}
                <Badge size="sm" tone={roleMeta[p.role].tone}>
                  {roleMeta[p.role].label}
                </Badge>
              </span>
              <span className="text-caption text-text-muted">
                {p.last_test ? `Last test ${p.last_test.status} · ${formatDateTime(p.last_test.at)}` : 'Never tested'}
              </span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => onOverlay({ kind: 'manage', id: p.id })}>
              Manage
            </Button>
            <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg" onClick={() => onOverlay({ kind: 'remove', provider: p })}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

