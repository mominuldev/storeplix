import { ApiError } from '@storeplix/api-client';
import type { DomainFailureCode } from '@storeplix/types';
import { describe, expect, it } from 'vitest';
import { connectDomainSchema, connectErrorMessage, deadlineText, failureCopy, failureText, looksLikeApex, railSteps, remainingText, stripHostname } from '../online-store/domains/domainCopy';
import { domainsPollInterval, POLL_MS } from '../online-store/domains/queries';
import { domain, record } from './domains.fixtures';

describe('hostname clean-up (§8 Connect dialog)', () => {
  it('strips scheme, path, query, trailing slash and dot; lowercases', () => {
    expect(stripHostname('  https://Shop.Acme.com/products?x=1 ')).toBe('shop.acme.com');
    expect(stripHostname('http://www.acme.com/')).toBe('www.acme.com');
    expect(stripHostname('acme.com.')).toBe('acme.com');
    expect(stripHostname('shop.acme.com#top')).toBe('shop.acme.com');
  });

  it('validates with Zod after stripping', () => {
    expect(connectDomainSchema.safeParse({ hostname: 'https://www.acme.com/' }).data).toEqual({ hostname: 'www.acme.com' });
    expect(connectDomainSchema.safeParse({ hostname: '   ' }).success).toBe(false);
    expect(connectDomainSchema.safeParse({ hostname: 'localhost' }).success).toBe(false);
    expect(connectDomainSchema.safeParse({ hostname: 'shop.acme.com:8080' }).success).toBe(false);
    expect(connectDomainSchema.safeParse({ hostname: 'my shop.com' }).success).toBe(false);
    expect(connectDomainSchema.safeParse({ hostname: `${'a'.repeat(250)}.com` }).success).toBe(false);
  });

  it('apex hint: two labels, or three with a BD second level', () => {
    expect(looksLikeApex('acme.com')).toBe(true);
    expect(looksLikeApex('mugdho.com.bd')).toBe(true);
    expect(looksLikeApex('shop.acme.com')).toBe(false);
    expect(looksLikeApex('www.mugdho.com.bd')).toBe(false);
    expect(looksLikeApex('shop.co.uk')).toBe(false);
  });
});

describe('copy', () => {
  it('has copy for every failure code and a fallback for new ones', () => {
    const codes: DomainFailureCode[] = ['txt_missing', 'txt_mismatch', 'cname_missing', 'cname_mismatch', 'dns_error', 'verification_timeout', 'provider_error', 'provider_blocked', 'provider_moved', 'ssl_validation_failed', 'ssl_timeout', 'ssl_lost', 'suspended'];
    for (const c of codes) expect(failureText(c)).toBe(failureCopy[c]);
    expect(failureText(null)).toBeNull();
    expect(failureText('brand_new_code')).toMatch(/Check the records/);
  });

  it('maps add errors to inline copy', () => {
    expect(connectErrorMessage(new ApiError(422, 'domain_taken', 'x'))).toMatch(/already connected/);
    expect(connectErrorMessage(new ApiError(422, 'domain_reserved', 'x'))).toMatch(/Storeplix addresses/);
    expect(connectErrorMessage(new ApiError(422, 'domain_invalid', 'x'))).toMatch(/doesn’t look like a domain/);
    expect(connectErrorMessage(new ApiError(402, 'plan_limit_reached', 'x'), 2)).toBe('Your plan allows 2 custom domains. Remove one or upgrade.');
    expect(connectErrorMessage(new ApiError(402, 'feature_not_in_plan', 'x'))).toMatch(/Upgrade/);
    expect(connectErrorMessage(new ApiError(429, 'rate_limited', 'x', undefined, 30))).toBe('Too many tries. Try again in 30 seconds.');
    expect(connectErrorMessage(new ApiError(422, 'validation_failed', 'x', { hostname: ['Too long.'] }))).toBe('Too long.');
  });

  it('formats deadlines', () => {
    const now = Date.parse('2026-11-22T00:00:00Z');
    expect(remainingText('2026-11-24T14:00:00Z', now)).toBe('2 days 14 h');
    expect(remainingText('2026-11-22T05:10:00Z', now)).toBe('5 h 10 min');
    expect(remainingText('2026-11-22T00:25:00Z', now)).toBe('25 min');
    expect(remainingText('2026-11-21T00:00:00Z', now)).toBeNull();
    expect(deadlineText({ status: 'pending_verification', deadline_at: '2026-11-24T14:00:00Z' }, now)).toBe('We’ll keep checking for 2 days 14 h.');
    expect(deadlineText({ status: 'active', deadline_at: '2026-11-25T00:00:00Z' }, now)).toMatch(/within 3 days/);
  });
});

describe('step rail and polling', () => {
  const states = (d: Parameters<typeof railSteps>[0]) => railSteps(d).map((s) => s.state);
  it('follows the status', () => {
    expect(states(domain({ dns_records: [record('ownership', { status: 'pending' }), record('routing', { status: 'pending' })] }))).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
    expect(states(domain())).toEqual(['done', 'current', 'upcoming', 'upcoming']);
    expect(railSteps(domain())[1]!.caption).toBe('1 of 2 found');
    expect(states(domain({ status: 'ssl_provisioning' }))).toEqual(['done', 'done', 'current', 'upcoming']);
    expect(states(domain({ status: 'active' }))).toEqual(['done', 'done', 'done', 'done']);
    expect(states(domain({ status: 'verification_failed', failure_code: 'ssl_timeout' }))).toEqual(['done', 'done', 'error', 'upcoming']);
    expect(states(domain({ status: 'expired', failure_code: 'cname_missing' }))).toEqual(['done', 'error', 'upcoming', 'upcoming']);
  });

  it('polls every 15 s only while a row is moving', () => {
    expect(domainsPollInterval([{ status: 'active' }, { status: 'pending_verification' }])).toBe(POLL_MS);
    expect(domainsPollInterval([{ status: 'verified' }])).toBe(15_000);
    expect(domainsPollInterval([{ status: 'ssl_provisioning' }])).toBe(15_000);
    expect(domainsPollInterval([{ status: 'active' }, { status: 'verification_failed' }, { status: 'expired' }, { status: 'suspended' }])).toBe(false);
    expect(domainsPollInterval(undefined)).toBe(false);
  });
});
