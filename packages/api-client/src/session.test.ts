import { describe, expect, it } from 'vitest';
import { createSessionStore } from './session';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

function make(now = Date.parse('2026-11-21T10:00:00Z')) {
  const tabStorage = new MemoryStorage();
  const prefsStorage = new MemoryStorage();
  const session = createSessionStore({ prefix: 't', sessionStorage: tabStorage, prefsStorage, now: () => now });
  return { session, tabStorage, prefsStorage };
}

const keysOf = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i));

describe('createSessionStore (4.7b: cookie session, no token)', () => {
  it('keeps only expires_at + a signed-in flag per tab and the tenant preference separately; never a token', () => {
    const { session, tabStorage, prefsStorage } = make();
    session.start({ expires_at: '2026-11-28T10:00:00Z' });
    session.setTenantId('tenant-1');
    expect(session.isSignedIn()).toBe(true);
    expect(keysOf(tabStorage).sort()).toEqual(['t.expires_at', 't.signed_in']);
    expect(keysOf(tabStorage).some((k) => k?.includes('token'))).toBe(false);
    expect(keysOf(prefsStorage)).toEqual(['t.tenant']);
    expect(session.msUntilExpiry()).toBe(7 * 24 * 3600 * 1000);
    expect(session.isExpired()).toBe(false);
  });

  it('detects expiry and leaves a one-shot notice on expire(); bumps the epoch', () => {
    const { session } = make();
    session.start({ expires_at: '2026-11-21T09:59:59Z' });
    const epoch = session.getEpoch();
    expect(session.isExpired()).toBe(true);
    session.expire();
    expect(session.isSignedIn()).toBe(false);
    expect(session.getEpoch()).toBe(epoch + 1);
    expect(session.consumeNotice()).toBe('session_expired');
    expect(session.consumeNotice()).toBeNull();
  });

  it('expire() is a no-op when signed out, clear() leaves no notice', () => {
    const { session } = make();
    session.expire();
    expect(session.peekNotice()).toBeNull();
    session.start({});
    session.clear();
    expect(session.isSignedIn()).toBe(false);
    expect(session.peekNotice()).toBeNull();
  });
});
