import type { ApiError } from '@storeplix/api-client';
import type { DomainFailureCode, DomainStatus, StoreDomain } from '@storeplix/types';
import { z } from 'zod';

// PHASE-6-CONTRACT §8: client-side hostname clean-up (the API normalises again, P6-4), apex hint without a PSL,
// failure copy per `failure_code`, error mapping for the Connect dialog, deadline text and the step rail.

/** Strips `http(s)://`, any path/query/fragment and trailing `/`, surrounding space and one trailing dot. */
export function stripHostname(raw: string): string {
  let v = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const cut = v.search(/[/?#]/);
  if (cut >= 0) v = v.slice(0, cut);
  return v.replace(/\.$/, '').toLowerCase();
}

export const connectDomainSchema = z.object({
  hostname: z
    .string()
    .transform(stripHostname)
    .pipe(
      z
        .string()
        .min(1, 'Enter the domain you want to connect.')
        .max(253, 'A domain can be at most 253 characters.')
        .refine((v) => !/[\s@:*]/.test(v), 'Enter just the domain, like www.yourshop.com.')
        .refine((v) => v.includes('.') && !v.startsWith('.') && !v.includes('..'), 'Enter a full domain, like www.yourshop.com.'),
    ),
});
export type ConnectDomainInput = z.input<typeof connectDomainSchema>;
export type ConnectDomainValues = z.output<typeof connectDomainSchema>;

/** Bangladeshi second-level suffixes treated as a single TLD for the apex hint (no PSL in the browser). */
const BD_SECOND_LEVEL = new Set(['com.bd', 'net.bd', 'org.bd', 'edu.bd', 'gov.bd', 'ac.bd']);

/** "Looks like an apex": exactly two labels, or three with a known BD second level (e.g. `shop.com.bd`). */
export function looksLikeApex(host: string): boolean {
  const labels = host.split('.').filter(Boolean);
  if (labels.length === 2) return true;
  return labels.length === 3 && BD_SECOND_LEVEL.has(labels.slice(1).join('.'));
}

export const failureCopy: Record<DomainFailureCode, string> = {
  txt_missing: 'We can’t see the TXT record yet. Add it exactly as shown below.',
  txt_mismatch: 'The TXT record has a different value. Replace it with the value shown below.',
  cname_missing: 'We can’t see the CNAME record yet. Add it exactly as shown below.',
  cname_mismatch: 'Your domain points somewhere else. Change the CNAME record to the value shown below.',
  dns_error: 'We couldn’t reach the DNS servers this time. We’ll try again automatically.',
  verification_timeout: 'We couldn’t find your records within 72 hours. Check them and press Check now to try again.',
  provider_error: 'Something went wrong while securing your domain. We’ll try again automatically.',
  provider_blocked: 'This domain can’t be secured. Contact support if you think this is a mistake.',
  provider_moved: 'Your domain no longer points to Storeplix. Check the CNAME record.',
  ssl_validation_failed: 'We couldn’t issue the secure lock (SSL). Check the CNAME record and try again.',
  ssl_timeout: 'Securing the domain took too long. Check the records and press Check now to try again.',
  ssl_lost: 'The secure lock (SSL) stopped working. Check your records; we keep checking.',
  suspended: 'This domain was suspended by Storeplix. Contact support.',
  plan_limit: 'This domain was disconnected because your plan doesn’t include it. Upgrade, then press Check now to connect it again.',
};

export function failureText(code: string | null | undefined): string | null {
  if (!code) return null;
  return failureCopy[code as DomainFailureCode] ?? 'Something is wrong with this domain. Check the records below.';
}

/** Connect dialog: inline copy for the add errors (§4.0). `null` = generic message. */
export function connectErrorMessage(err: ApiError, limitMax?: number | null): string {
  switch (err.code) {
    case 'domain_invalid':
      return 'That doesn’t look like a domain you can connect. Check the spelling, e.g. www.yourshop.com.';
    case 'domain_reserved':
      return 'Storeplix addresses can’t be connected here. Use a domain you bought.';
    case 'domain_taken':
      return 'This domain is already connected to a shop. If it’s yours, remove it there first or contact support.';
    case 'feature_not_in_plan':
      return 'Your plan doesn’t include your own domain. Upgrade to connect one.';
    case 'plan_limit_reached':
      return limitMax != null ? `Your plan allows ${limitMax} custom domain${limitMax === 1 ? '' : 's'}. Remove one or upgrade.` : 'You’ve reached your plan’s domain limit.';
    case 'rate_limited':
      return err.retryAfter ? `Too many tries. Try again in ${err.retryAfter} seconds.` : 'Too many tries. Wait a minute and try again.';
    case 'forbidden':
      return 'Only the owner or a manager can connect domains.';
    case 'validation_failed':
      return err.fieldError('hostname') ?? 'Enter a valid domain, like www.yourshop.com.';
    default:
      return err.message || 'We couldn’t connect this domain. Try again.';
  }
}

/** "2 days 14 h", "5 h 10 min", "25 min" until `iso`; null when past or missing. */
export function remainingText(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = Math.ceil(ms / 60_000);
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const mins = min % 60;
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}${hours ? ` ${hours} h` : ''}`;
  if (hours > 0) return `${hours} h${mins ? ` ${mins} min` : ''}`;
  return `${mins} min`;
}

export function deadlineText(d: Pick<StoreDomain, 'status' | 'deadline_at'>, now = Date.now()): string | null {
  const left = remainingText(d.deadline_at, now);
  if (!left) return null;
  if (d.status === 'active') return `Fix the records within ${left} or the domain will disconnect.`;
  return `We’ll keep checking for ${left}.`;
}

/** Statuses that change on their own (polling runs while any row has one, §8). */
export const MOVING: readonly DomainStatus[] = ['pending_verification', 'verified', 'ssl_provisioning'];
export const isMoving = (s: DomainStatus) => MOVING.includes(s);

export type StepState = 'done' | 'current' | 'error' | 'upcoming';
export interface RailStep {
  key: 'records' | 'dns' | 'ssl' | 'live';
  label: string;
  caption: string;
  state: StepState;
}

const SSL_FAILURES = new Set(['ssl_validation_failed', 'ssl_timeout', 'provider_blocked', 'provider_error', 'ssl_lost', 'provider_moved']);

/** Step rail Add records → Checking DNS → Securing (SSL) → Live (§8). */
export function railSteps(d: Pick<StoreDomain, 'status' | 'dns_records' | 'failure_code'>): RailStep[] {
  const found = d.dns_records.filter((r) => r.status === 'ok').length;
  const total = d.dns_records.length || 2;
  // Index of the step the domain is at, and whether that step failed.
  let at = 0;
  let failed = false;
  switch (d.status) {
    case 'pending_verification':
      at = found > 0 || d.dns_records.some((r) => r.status !== 'pending') ? 1 : 0;
      break;
    case 'verified':
    case 'ssl_provisioning':
      at = 2;
      break;
    case 'active':
      at = 4;
      break;
    case 'verification_failed':
      at = d.failure_code && SSL_FAILURES.has(d.failure_code) ? 2 : 1;
      failed = true;
      break;
    case 'expired':
      at = 1;
      failed = true;
      break;
    case 'suspended':
      at = 3;
      failed = true;
      break;
  }
  const state = (i: number): StepState => (i < at ? 'done' : i === at ? (failed ? 'error' : 'current') : 'upcoming');
  return [
    { key: 'records', label: 'Add records', caption: 'At your seller', state: state(0) },
    { key: 'dns', label: 'Checking DNS', caption: `${found} of ${total} found`, state: state(1) },
    { key: 'ssl', label: 'Securing (SSL)', caption: 'Free · automatic', state: state(2) },
    { key: 'live', label: 'Live', caption: d.status === 'active' ? 'Buyers can visit' : 'Shop on this domain', state: state(3) },
  ];
}
