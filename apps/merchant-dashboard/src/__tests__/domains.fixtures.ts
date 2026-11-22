import type { DomainDnsRecord, DomainListMeta, StoreDomain } from '@storeplix/types';
import { jsonResponse } from '../test/utils';

// Phase 6 domain fixtures shaped like openapi 1.7.0 StoreDomain / DomainListMeta (PHASE-6-CONTRACT §6).

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

export function record(purpose: 'ownership' | 'routing', r: Partial<DomainDnsRecord> = {}): DomainDnsRecord {
  return purpose === 'ownership'
    ? { purpose, type: 'TXT', name: '_storeplix-verify.shop.mugdho.com', name_relative: '_storeplix-verify.shop', value: 'sp-verify=abcdefgh', status: 'missing', found: [], ...r }
    : { purpose, type: 'CNAME', name: 'shop.mugdho.com', name_relative: 'shop', value: 'customers.storeplix.test', status: 'ok', found: ['customers.storeplix.test'], ...r };
}

export function domain(d: Partial<StoreDomain> = {}): StoreDomain {
  return {
    id: 'D2',
    hostname: 'shop.mugdho.com',
    display_hostname: 'shop.mugdho.com',
    type: 'custom',
    status: 'pending_verification',
    is_primary: false,
    is_apex: false,
    routable: false,
    dns_records: [record('ownership'), record('routing')],
    ssl_status: 'none',
    verification_started_at: iso(30),
    verified_at: null,
    activated_at: null,
    status_changed_at: iso(30),
    last_checked_at: iso(2),
    next_check_at: iso(-5),
    deadline_at: new Date(Date.now() + (2 * 24 + 14) * 3600_000 + 60_000).toISOString(),
    failure_code: 'txt_missing',
    failure_message: null,
    can_recheck: true,
    can_make_primary: false,
    can_remove: true,
    created_at: iso(30),
    updated_at: iso(2),
    ...d,
  };
}

export const platformDomain = (d: Partial<StoreDomain> = {}) =>
  domain({
    id: 'D1',
    hostname: 'mugdho.storeplix.com',
    display_hostname: 'mugdho.storeplix.com',
    type: 'platform',
    status: 'active',
    is_primary: true,
    routable: true,
    dns_records: [],
    ssl_status: 'active',
    deadline_at: null,
    failure_code: null,
    last_checked_at: null,
    can_recheck: false,
    can_make_primary: true,
    can_remove: false,
    ...d,
  });

export const activeDomain = (d: Partial<StoreDomain> = {}) =>
  domain({
    id: 'D3',
    hostname: 'www.mugdho.com',
    display_hostname: 'www.mugdho.com',
    status: 'active',
    routable: true,
    ssl_status: 'active',
    dns_records: [record('ownership', { name: '_storeplix-verify.www.mugdho.com', name_relative: '_storeplix-verify.www', status: 'ok' }), record('routing', { name: 'www.mugdho.com', name_relative: 'www' })],
    deadline_at: null,
    failure_code: null,
    can_make_primary: true,
    ...d,
  });

export function listMeta(m: Partial<DomainListMeta> = {}): DomainListMeta {
  return { cname_target: 'customers.storeplix.test', txt_prefix: '_storeplix-verify', can_add: true, feature_enabled: true, limit: { used: 1, max: 2 }, ...m };
}

export const domainsResponse = (rows: StoreDomain[], m: Partial<DomainListMeta> = {}) => jsonResponse(200, { data: rows, meta: listMeta(m) });

/** Staff view: every can_* flag false (contract §6 field rules). */
export const asStaff = (d: StoreDomain): StoreDomain => ({ ...d, can_recheck: false, can_make_primary: false, can_remove: false });
