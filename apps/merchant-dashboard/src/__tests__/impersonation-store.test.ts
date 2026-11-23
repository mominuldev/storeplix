import type { MeImpersonation } from '@storeplix/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expireSession, impersonation } from '../impersonation/store';

const info = {
  id: '01jbx0000000000000000000ab',
  tenant_id: '01jbx0000000000000000000cd',
  tenant_name: 'Mugdho Fashion',
  owner_name: 'Rahim Ahmed',
  reason: 'Ticket 4821',
  expires_at: '2026-11-23T10:15:00Z',
} as unknown as MeImpersonation;

describe('impersonation store (QA P8-QA-8)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    impersonation._reload();
  });
  afterEach(() => sessionStorage.clear());

  it('a plain 401 after a reload still ends the support session instead of showing the login page', () => {
    impersonation.begin(info);
    // Reload: the in-memory info is gone, the tab flag survives.
    impersonation._reload();
    expect(impersonation.get()).toBeNull();
    expireSession();
    expect(impersonation.isEnded()).toBe(true);
  });

  it('outside impersonation a 401 is a normal session expiry', () => {
    impersonation.set(null);
    expireSession();
    expect(impersonation.isEnded()).toBe(false);
  });

  it('sign-out and a normal /auth/me clear the flag', () => {
    impersonation.begin(info);
    impersonation.reset();
    impersonation._reload();
    expireSession();
    expect(impersonation.isEnded()).toBe(false);

    impersonation.begin(info);
    impersonation.set(null);
    impersonation._reload();
    expireSession();
    expect(impersonation.isEnded()).toBe(false);
  });
});
