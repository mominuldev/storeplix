import type { DomainDnsRecord, StoreDomain } from '@storeplix/types';
import { Button, cn, CopyValue, DnsRecordStatusBadge, DomainStatusBadge } from '@storeplix/ui';
import { AlertTriangle, Check, Clock, Info, Lock, Rocket, ShieldCheck, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { relativeTime } from '../hooks';
import { deadlineText, failureText, railSteps, type RailStep } from './domainCopy';

// Figma V3 Domains "Connecting" card 2042:48093: title row 2042:48094 (22px host + status pill + Check now), step rail
// 2042:48104, DNS table 2042:48130 (header 2042:48131, rows 2042:48136/48149/48162, value chip + copy 2042:48139,
// status pill 2042:48145), radius 16, px 24 py 22, Elevation/1. The "Step-by-step for your domain seller" chips and
// "Do it for me" (2042:48175) are out of scope (no guides / Domain Connect in Phase 6) and are not built.
// Below md the table turns into one card per record (contract §8 mobile).

export interface DnsRecordsCardProps {
  domain: StoreDomain;
  canRecheck: boolean;
  checking: boolean;
  /** Seconds until "Check now" is allowed again after a 429. */
  cooldown: number;
  onCheck: () => void;
  className?: string;
}

export function DnsRecordsCard({ domain, canRecheck, checking, cooldown, onCheck, className }: DnsRecordsCardProps) {
  const [fqdn, setFqdn] = useState(false);
  const failure = failureText(domain.failure_code);
  const deadline = deadlineText(domain);
  const steps = railSteps(domain);
  const showPunycode = domain.display_hostname !== domain.hostname;
  const anyRecordWrong = domain.dns_records.some((r) => r.status !== 'ok');
  const subtitle = [
    showPunycode ? domain.hostname : null,
    domain.is_primary ? 'Your main address' : null,
    domain.last_checked_at ? `Checked ${relativeTime(domain.last_checked_at)}` : 'Not checked yet',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      aria-label={`DNS records for ${domain.display_hostname}`}
      className={cn('flex flex-col gap-5 rounded-card border border-border-default bg-surface-card px-4 py-5 shadow-elevation-1 sm:px-6 sm:py-[22px]', className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 text-[22px] leading-[30px] font-semibold tracking-[-0.01em] break-all text-text-primary">{domain.display_hostname}</h2>
            <DomainStatusBadge status={domain.status} />
          </div>
          <p className="text-[13px] leading-[18px] text-text-muted">{subtitle}</p>
        </div>
        {canRecheck && (
          <Button variant="secondary" size="sm" onClick={onCheck} loading={checking} disabled={cooldown > 0}>
            {cooldown > 0 ? `Check again in ${cooldown} s` : 'Check now'}
          </Button>
        )}
      </div>

      <StepRail steps={steps} />

      {failure && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-bg px-4 py-3 text-body text-danger">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{failure}</span>
        </div>
      )}

      {domain.dns_records.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-body text-text-secondary">Add these {domain.dns_records.length} records where you bought the domain.</p>
            <button type="button" onClick={() => setFqdn((v) => !v)} className="text-caption font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
              {fqdn ? 'Show short names' : 'Show full names'}
            </button>
          </div>
          <div role="table" aria-label="DNS records" className="flex flex-col overflow-hidden rounded-lg border border-border-default">
            <div role="row" className="hidden gap-4 bg-surface-subtle px-4 py-2.5 text-caption font-medium text-text-muted md:grid md:grid-cols-[70px_minmax(0,150px)_minmax(0,1fr)_120px]">
              <span role="columnheader">Type</span>
              <span role="columnheader">Name</span>
              <span role="columnheader">Value</span>
              <span role="columnheader">Status</span>
            </div>
            {domain.dns_records.map((r) => (
              <RecordRow key={`${r.purpose}-${r.type}`} record={r} fqdn={fqdn} />
            ))}
          </div>
        </div>
      )}

      {domain.dns_records.length > 0 && (anyRecordWrong || deadline || domain.is_apex) && (
        <ul className="flex flex-col gap-1.5 text-[13px] leading-[18px] text-text-secondary">
          {deadline && <Tip icon={<Clock />}>{deadline}</Tip>}
          {anyRecordWrong && <Tip icon={<Info />}>DNS changes can take up to an hour to show. We check again on our own.</Tip>}
          {domain.failure_code === 'cname_mismatch' && (
            <Tip icon={<Info />}>
              Using Cloudflare? Turn off the proxy (orange cloud) for this record: set it to <strong className="font-semibold">DNS only</strong>.
            </Tip>
          )}
          {domain.is_apex && <Tip icon={<Info />}>Your DNS provider must support CNAME flattening or ALIAS records for the main domain (@).</Tip>}
        </ul>
      )}
    </section>
  );
}

function Tip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className="mt-px text-text-muted [&_svg]:size-4">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  );
}

function RecordRow({ record: r, fqdn }: { record: DomainDnsRecord; fqdn: boolean }) {
  const wrong = r.status === 'missing' || r.status === 'mismatch';
  const name = fqdn ? r.name : r.name_relative;
  return (
    <div
      role="row"
      aria-label={`${r.type} record`}
      className={cn(
        'flex flex-col gap-2 border-t border-border-default px-4 py-3 [&:nth-child(2)]:border-t-0 md:grid md:grid-cols-[70px_minmax(0,150px)_minmax(0,1fr)_120px] md:items-center md:gap-4 md:[&:nth-child(2)]:border-t',
        wrong && 'bg-warning-bg',
      )}
    >
      <div role="cell" className="flex items-center justify-between gap-2">
        <span className="text-[13px] leading-[18px] font-semibold text-text-primary">{r.type}</span>
        <DnsRecordStatusBadge status={r.status} className="md:hidden" />
      </div>
      <div role="cell" className="flex min-w-0 flex-col gap-1">
        <span className="text-caption text-text-muted md:hidden">Name</span>
        <CopyValue value={name} label={`Copy ${r.type} name`} />
      </div>
      <div role="cell" className="flex min-w-0 flex-col gap-1">
        <span className="text-caption text-text-muted md:hidden">Value</span>
        <CopyValue value={r.value} label={`Copy ${r.type} value`} />
        {r.status === 'mismatch' && r.found.length > 0 && <span className="text-caption break-all text-danger">We found: {r.found.join(', ')}</span>}
      </div>
      <div role="cell" className="hidden md:block">
        <DnsRecordStatusBadge status={r.status} />
      </div>
    </div>
  );
}

const stepIcon: Record<RailStep['key'], ReactNode> = {
  records: <Check />,
  dns: <Clock />,
  ssl: <Lock />,
  live: <Rocket />,
};

/** Step rail 2042:48104: 28px circles (done success, current warning-bg, upcoming subtle) joined by 2px lines. */
function StepRail({ steps }: { steps: RailStep[] }) {
  return (
    <ol aria-label="Progress" className="grid grid-cols-2 gap-3 sm:flex sm:items-center sm:gap-0">
      {steps.map((s, i) => (
        <li key={s.key} aria-current={s.state === 'current' ? 'step' : undefined} className="flex min-w-0 items-center sm:flex-1 sm:last:flex-none">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-[15px]',
                s.state === 'done' && 'bg-success text-text-inverse',
                s.state === 'current' && 'bg-warning-bg text-warning',
                s.state === 'error' && 'bg-danger-bg text-danger',
                s.state === 'upcoming' && 'bg-surface-subtle text-text-muted',
              )}
            >
              {s.state === 'done' ? <Check /> : s.state === 'error' ? <X /> : s.key === 'ssl' && s.state === 'current' ? <ShieldCheck /> : stepIcon[s.key]}
            </span>
            <span className={cn('flex min-w-0 flex-col', s.state === 'upcoming' && 'text-text-muted')}>
              <span className={cn('text-[13px] leading-[18px] font-semibold', s.state !== 'upcoming' && 'text-text-primary')}>
                {s.label}
                <span className="sr-only">{` (${s.state})`}</span>
              </span>
              <span className="truncate text-[11px] leading-4 text-text-muted">{s.caption}</span>
            </span>
          </div>
          {i < steps.length - 1 && <span aria-hidden className={cn('mx-3 hidden h-0.5 min-w-4 flex-1 sm:block', s.state === 'done' ? 'bg-success' : 'bg-border-default')} />}
        </li>
      ))}
    </ol>
  );
}

/** Platform address detail: no records, never removable (P6-9). */
export function PlatformAddressCard({ domain, className }: { domain: StoreDomain; className?: string }) {
  return (
    <section aria-label={`About ${domain.hostname}`} className={cn('flex flex-col gap-3 rounded-card border border-border-default bg-surface-card px-4 py-5 shadow-elevation-1 sm:px-6', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[22px] leading-[30px] font-semibold break-all text-text-primary">{domain.display_hostname}</h2>
        <DomainStatusBadge status="active" />
      </div>
      <p className="flex items-center gap-2 text-body text-text-secondary">
        <Lock aria-hidden className="size-4 shrink-0 text-text-muted" />
        Your free Storeplix address. It always works, has a free secure lock (SSL) and can’t be removed.
      </p>
    </section>
  );
}
