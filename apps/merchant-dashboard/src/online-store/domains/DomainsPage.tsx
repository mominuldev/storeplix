import { isApiError } from '@storeplix/api-client';
import { handlePlanLimit } from '../../plan/Banners';
import { usePlans } from '../../plan/billing';
import type { DomainListMeta, StoreDomain } from '@storeplix/types';
import { Badge, Button, Dialog, DomainStatusBadge, EmptyState, Input, Menu, type MenuEntry } from '@storeplix/ui';
import { ArrowRight, Globe, Lock, RefreshCw, Star, Trash2, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useStoreScope } from '../../catalog/scope';
import { ErrorState, LoadingState, OnlineStoreHeader, ReadOnlyBanner } from '../components/Shell';
import { toast } from '../components/Toast';
import { relativeTime } from '../hooks';
import { ConnectDomainDialog } from './ConnectDomainDialog';
import { DnsRecordsCard, PlatformAddressCard } from './DnsRecordsCard';
import { isMoving } from './domainCopy';
import { useCooldowns, useDomain, useDomains, useMakePrimary, useRecheckDomain, useRemoveDomain } from './queries';

// Figma V3 Online store · Domains 2042:47403 (Body 2042:47407): page header 2042:47408 (title, description, Connect a
// domain; "Buy a domain" 2042:48087 is out of scope and hidden), left column 2042:48092 with the focused domain's
// records card 2042:48093 and "All addresses" 2042:48187 (rows 2042:48190/48202/48214: host + pill, sub line, status
// pill, Manage), right column 2042:48226 with "Good to know" 2042:48239 (the "No domain yet?" buy card 2042:48227 is
// out of scope). States from 148:34032 (Loading 148:35302, Error 148:35336, empty 148:35352).

export function DomainsPage() {
  const { domainId } = useParams();
  const navigate = useNavigate();
  const scope = useStoreScope();
  const canManage = scope.canManageDomains;
  const list = useDomains();
  const detail = useDomain(domainId);
  const recheck = useRecheckDomain();
  const cooldowns = useCooldowns();
  const [connectOpen, setConnectOpen] = useState(false);
  const [primaryTarget, setPrimaryTarget] = useState<StoreDomain | null>(null);
  const [removeTarget, setRemoveTarget] = useState<StoreDomain | null>(null);

  const domains = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;
  const platform = domains.find((d) => d.type === 'platform' && scope.store && d.hostname.startsWith(`${scope.store.slug}.`)) ?? domains.find((d) => d.type === 'platform');
  const primary = domains.find((d) => d.is_primary);
  const custom = domains.filter((d) => d.type === 'custom');

  // Focused domain: the route's id (fresh from the list when present), else the first custom domain that isn't live.
  const focused: StoreDomain | undefined = domainId ? (domains.find((d) => d.id === domainId) ?? detail.data) : custom.find((d) => d.status !== 'active');

  const check = (d: StoreDomain) =>
    recheck.mutate(d.id, {
      onSuccess: (row) => {
        if (row.status === 'active') toast(`${row.display_hostname} is connected.`);
        else if (row.failure_code) toast('Checked. Some records still need attention.', 'error');
        else toast('Checked. We’ll keep watching.');
      },
      onError: (e) => {
        if (isApiError(e) && e.status === 429) {
          cooldowns.start(d.id, e.retryAfter ?? 60);
          toast(`Checked too often. Try again in ${e.retryAfter ?? 60} seconds.`, 'error');
        } else if (isApiError(e) && e.code === 'invalid_state_transition') toast('This domain is suspended. Contact support.', 'error');
        // Phase 7 §2.1 b: re-checking a detached (`plan_limit`) domain needs the plan → upgrade dialog.
        else if (handlePlanLimit(e)) return;
        else toast(isApiError(e) && e.message ? e.message : 'We couldn’t check this domain. Try again.', 'error');
      },
    });

  const header = (
    <OnlineStoreHeader
      title="Domains"
      description="The address buyers type to reach your shop."
      actions={canManage && meta?.feature_enabled ? <ConnectButton meta={meta} onClick={() => setConnectOpen(true)} /> : undefined}
    />
  );

  if (list.isPending) {
    return (
      <div className="flex flex-col gap-6 lg:gap-7">
        {header}
        <LoadingState label="Loading domains" />
      </div>
    );
  }
  if (list.isError) {
    return (
      <div className="flex flex-col gap-6 lg:gap-7">
        {header}
        <ErrorState message="We couldn’t load your domains. Check your connection and try again." onRetry={() => void list.refetch()} />
      </div>
    );
  }

  const notFound = !!domainId && !focused && detail.isError;

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      {header}
      {!canManage && <ReadOnlyBanner />}
      {meta && <PlanNotice meta={meta} canManage={canManage} />}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          {notFound ? (
            <div className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
              <EmptyState
                icon={<Globe />}
                title="Domain not found"
                description="It may have been removed, or it belongs to another shop."
                action={
                  <Button variant="secondary" onClick={() => navigate('/online-store/domains')}>
                    Back to domains
                  </Button>
                }
              />
            </div>
          ) : domainId && !focused ? (
            <LoadingState label="Loading domain" />
          ) : focused?.type === 'platform' ? (
            <PlatformAddressCard domain={focused} />
          ) : focused ? (
            <DnsRecordsCard domain={focused} canRecheck={focused.can_recheck} checking={recheck.isPending && recheck.variables === focused.id} cooldown={cooldowns.left(focused.id)} onCheck={() => check(focused)} />
          ) : custom.length === 0 ? (
            <div className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
              <EmptyState
                icon={<Globe />}
                title="Connect your own domain"
                description={`Buyers can already reach you at ${platform?.display_hostname ?? 'your Storeplix address'}. Connect a domain you own, like www.yourshop.com.`}
                action={
                  canManage && meta?.feature_enabled ? (
                    <ConnectButton meta={meta} onClick={() => setConnectOpen(true)} />
                  ) : undefined
                }
              />
            </div>
          ) : null}

          <section aria-labelledby="all-addresses" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="all-addresses" className="text-[15px] leading-[22px] font-semibold text-text-primary">
                All addresses
              </h2>
              {meta && meta.limit.max !== null && meta.feature_enabled && (
                <span className="text-caption text-text-muted">
                  {meta.limit.used} of {meta.limit.max} custom domain{meta.limit.max === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <ul className="flex flex-col overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">
              {domains.map((d) => (
                <DomainRow
                  key={d.id}
                  domain={d}
                  primary={primary}
                  selected={focused?.id === d.id}
                  cooldown={cooldowns.left(d.id)}
                  onView={() => navigate(`/online-store/domains/${d.id}`)}
                  onCheck={() => check(d)}
                  onMakePrimary={() => setPrimaryTarget(d)}
                  onRemove={() => setRemoveTarget(d)}
                />
              ))}
            </ul>
            {domains.some((d) => isMoving(d.status)) && <p className="text-caption text-text-muted">This page updates on its own while a domain is connecting.</p>}
          </section>
        </div>

        <GoodToKnow platformHost={platform?.display_hostname} />
      </div>

      <ConnectDomainDialog
        open={connectOpen}
        limitMax={meta?.limit.max ?? null}
        onClose={() => setConnectOpen(false)}
        onConnected={(d) => {
          setConnectOpen(false);
          toast(`Now add the two DNS records for ${d.display_hostname}.`);
          navigate(`/online-store/domains/${d.id}`);
        }}
      />
      <MakePrimaryDialog domain={primaryTarget} onClose={() => setPrimaryTarget(null)} />
      <RemoveDomainDialog
        domain={removeTarget}
        fallbackHost={platform?.display_hostname}
        onClose={() => setRemoveTarget(null)}
        onRemoved={(d) => {
          setRemoveTarget(null);
          if (domainId === d.id) navigate('/online-store/domains', { replace: true });
        }}
      />
    </div>
  );
}

function ConnectButton({ meta, onClick }: { meta: DomainListMeta; onClick: () => void }) {
  const full = !meta.can_add && meta.limit.max !== null && meta.limit.used >= meta.limit.max;
  return (
    <Button onClick={onClick} disabled={!meta.can_add} title={full ? `Your plan allows ${meta.limit.max} custom domains` : undefined}>
      Connect a domain
    </Button>
  );
}

/** Plan states (§8): feature off → upgrade card; limit reached → note under the header. */
function PlanNotice({ meta, canManage }: { meta: DomainListMeta; canManage: boolean }) {
  if (!meta.feature_enabled) {
    return (
      <section aria-label="Upgrade for your own domain" className="flex flex-col gap-3 rounded-card border border-brand-100 bg-brand-50 p-5 sm:flex-row sm:items-center">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-card text-brand-600 [&_svg]:size-5">
          <Globe />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-body font-semibold text-text-primary">Use your own domain</h2>
          <p className="text-[13px] leading-[18px] text-text-secondary">Your plan doesn’t include custom domains. Upgrade to connect an address like www.yourshop.com.</p>
        </div>
        {canManage && (
          <Link to="/settings/plan" className="inline-flex items-center gap-1.5 self-start text-body font-semibold text-brand-600 hover:underline sm:self-center">
            See plans <ArrowRight aria-hidden className="size-4" />
          </Link>
        )}
      </section>
    );
  }
  if (canManage && !meta.can_add && meta.limit.max !== null && meta.limit.used >= meta.limit.max) {
    return <LimitNote max={meta.limit.max} />;
  }
  return null;
}

/** Limit reached: names the cheapest plan with more custom domains (Phase 7 §8.3 upgrade prompts). */
function LimitNote({ max }: { max: number }) {
  const plans = usePlans().data ?? [];
  const next = [...plans].sort((a, b) => a.price_amount - b.price_amount).find((p) => p.limits.custom_domains === null || p.limits.custom_domains > max);
  return (
    <p role="note" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface-subtle px-4 py-3 text-body text-text-secondary">
      <span className="min-w-0 flex-1">
        Your plan allows {max} custom domain{max === 1 ? '' : 's'}. Remove one to connect another, or upgrade.
      </span>
      <Link to={next ? `/settings/plan?upgrade=${next.code}` : '/settings/plan'} className="font-semibold text-brand-600 hover:underline">
        {next ? `Upgrade to ${next.name}${next.limits.custom_domains !== null ? ` · up to ${next.limits.custom_domains}` : ''}` : 'See plans'}
      </Link>
    </p>
  );
}

function rowSubline(d: StoreDomain, primary: StoreDomain | undefined): string {
  const parts: string[] = [];
  if (d.display_hostname !== d.hostname) parts.push(d.hostname);
  if (d.type === 'platform') parts.push('Storeplix address · always works');
  else if (d.status === 'active' && !d.is_primary && primary && (primary.type === 'custom' || d.type === 'custom')) parts.push(`Sends buyers to ${primary.display_hostname}`);
  else if (d.last_checked_at) parts.push(`Checked ${relativeTime(d.last_checked_at)}`);
  else parts.push('Not checked yet');
  return parts.join(' · ');
}

function DomainRow({
  domain: d,
  primary,
  selected,
  cooldown,
  onView,
  onCheck,
  onMakePrimary,
  onRemove,
}: {
  domain: StoreDomain;
  primary: StoreDomain | undefined;
  selected: boolean;
  cooldown: number;
  onView: () => void;
  onCheck: () => void;
  onMakePrimary: () => void;
  onRemove: () => void;
}) {
  const entries: MenuEntry[] = [];
  if (d.type === 'custom') entries.push({ key: 'records', label: 'View DNS records', icon: <FileText />, onSelect: onView });
  if (d.can_recheck) entries.push({ key: 'check', label: cooldown > 0 ? `Check again in ${cooldown} s` : 'Check now', icon: <RefreshCw />, disabled: cooldown > 0, onSelect: onCheck });
  if (d.can_make_primary && !d.is_primary) entries.push({ key: 'primary', label: 'Make primary', hint: 'Every other address sends buyers here', icon: <Star />, onSelect: onMakePrimary });
  if (d.can_remove) entries.push({ kind: 'separator', key: 'sep' }, { key: 'remove', label: 'Remove', icon: <Trash2 />, danger: true, onSelect: onRemove });

  return (
    <li aria-label={d.display_hostname} aria-current={selected ? 'true' : undefined} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-border-default py-3.5 pr-4 pl-5 first:border-t-0">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 text-body font-semibold break-all text-text-primary">{d.display_hostname}</span>
          {d.is_primary && <Badge tone="brand">Primary</Badge>}
          {d.type === 'platform' && <Lock aria-label="Can’t be removed" className="size-3.5 shrink-0 text-text-muted" />}
        </div>
        <span className="text-caption break-all text-text-muted">{rowSubline(d, primary)}</span>
      </div>
      <div className="ml-auto flex items-center gap-3.5">
        <DomainStatusBadge status={d.type === 'platform' ? 'active' : d.status} />
        {entries.length > 0 ? (
          <Menu label={`Manage ${d.display_hostname}`} trigger="Manage" entries={entries} triggerClassName="h-8 w-auto rounded-md px-3 text-caption font-medium text-brand-600 hover:bg-brand-50" />
        ) : (
          <span aria-hidden className="w-[71px]" />
        )}
      </div>
    </li>
  );
}

function GoodToKnow({ platformHost }: { platformHost?: string }) {
  const qa = [
    ['Will my shop go down?', `No. ${platformHost ?? 'Your Storeplix address'} keeps working the whole time.`],
    ['Do I pay for SSL?', 'No. The lock icon is free and renews itself.'],
    ['Why can it take a while?', 'DNS changes can take up to an hour to reach every internet provider. Some in Bangladesh update slowly.'],
    ['Root domain or www?', 'Use www.yourshop.com as your main address and add yourshop.com too, so both work.'],
  ] as const;
  return (
    <aside aria-labelledby="good-to-know" className="flex flex-col rounded-card border border-border-default bg-surface-card px-5 pt-[18px] pb-2 shadow-elevation-1">
      <h2 id="good-to-know" className="text-body font-semibold text-text-primary">
        Good to know
      </h2>
      <dl>
        {qa.map(([q, a]) => (
          <div key={q} className="flex flex-col gap-0.5 border-b border-border-default py-3 last:border-b-0">
            <dt className="text-[13px] leading-[18px] font-medium text-text-primary">{q}</dt>
            <dd className="text-caption leading-[17px] text-text-muted">{a}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function MakePrimaryDialog({ domain, onClose }: { domain: StoreDomain | null; onClose: () => void }) {
  const makePrimary = useMakePrimary();
  return (
    <Dialog
      open={!!domain}
      title={domain ? `Make ${domain.display_hostname} your main address?` : ''}
      description={
        domain
          ? `Visitors to every other address will be sent to ${domain.display_hostname}. Shoppers with an open cart on the old address will need to add items again.`
          : undefined
      }
      confirmLabel="Make primary"
      loading={makePrimary.isPending}
      onCancel={() => !makePrimary.isPending && onClose()}
      onConfirm={() =>
        domain &&
        makePrimary.mutate(domain.id, {
          onSuccess: () => {
            toast(`${domain.display_hostname} is now your main address.`);
            onClose();
          },
          onError: (e) => {
            const code = isApiError(e) ? e.code : '';
            toast(
              isApiError(e) && e.status === 429
                ? tooManyChanges(e.retryAfter)
                : code === 'domain_not_active'
                ? 'Only a connected domain can be your main address.'
                : code === 'feature_not_in_plan'
                  ? 'Your plan doesn’t include custom domains. Upgrade to use it as your main address.'
                  : 'We couldn’t change your main address. Try again.',
              'error',
            );
            onClose();
          },
        })
      }
    />
  );
}

function RemoveDomainDialog({ domain, fallbackHost, onClose, onRemoved }: { domain: StoreDomain | null; fallbackHost?: string; onClose: () => void; onRemoved: (d: StoreDomain) => void }) {
  const remove = useRemoveDomain();
  const [typed, setTyped] = useState('');
  const mustType = !!domain && (domain.is_primary || domain.status === 'active');
  const matches = !mustType || (!!domain && [domain.hostname, domain.display_hostname].includes(typed.trim().toLowerCase()));
  const close = () => {
    if (remove.isPending) return;
    setTyped('');
    onClose();
  };
  return (
    <Dialog
      open={!!domain}
      tone="danger"
      title={domain ? `Remove ${domain.display_hostname}?` : ''}
      description={domain ? 'Buyers can no longer reach your shop on this address. You can connect it again later.' : undefined}
      confirmLabel="Remove domain"
      confirmDisabled={!matches}
      loading={remove.isPending}
      onCancel={close}
      onConfirm={() =>
        domain &&
        remove.mutate(domain.id, {
          onSuccess: () => {
            toast(domain.is_primary && fallbackHost ? `Removed. Your shop will use ${fallbackHost} again.` : `${domain.display_hostname} was removed.`);
            setTyped('');
            onRemoved(domain);
          },
          onError: (e) => {
            toast(
              isApiError(e) && e.status === 429
                ? tooManyChanges(e.retryAfter)
                : isApiError(e) && e.code === 'platform_domain_locked'
                  ? 'Your Storeplix address can’t be removed.'
                  : 'We couldn’t remove this domain. Try again.',
              'error',
            );
          },
        })
      }
    >
      {domain && (
        <div className="flex flex-col gap-3">
          {domain.is_primary && fallbackHost && (
            <p className="rounded-lg bg-warning-bg px-3 py-2.5 text-[13px] leading-[18px] text-text-primary">
              This is your main address. Your shop will use <strong className="font-semibold">{fallbackHost}</strong> again.
            </p>
          )}
          {mustType && <Input label={`Type ${domain.display_hostname} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />}
        </div>
      )}
    </Dialog>
  );
}

function tooManyChanges(retryAfter?: number | null): string {
  return retryAfter ? `Too many changes. Try again in ${retryAfter} seconds.` : 'Too many changes. Wait a minute and try again.';
}

export default DomainsPage;
