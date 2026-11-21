import { describe, expect, it } from 'vitest';
import { createAuthSession } from './session';

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
  const tokenStorage = new MemoryStorage();
  const prefsStorage = new MemoryStorage();
  const session = createAuthSession({ prefix: 't', tokenStorage, prefsStorage, now: () => now });
  return { session, tokenStorage, prefsStorage };
}

describe('createAuthSession', () => {
  it('keeps the token in token storage and preferences separately', () => {
    const { session, tokenStorage, prefsStorage } = make();
    session.setAuth({ token: 'abc', expires_at: '2026-11-28T10:00:00Z' });
    session.setTenantId('tenant-1');
    expect(tokenStorage.getItem('t.token')).toBe('abc');
    expect(prefsStorage.getItem('t.token')).toBeNull();
    expect(prefsStorage.getItem('t.tenant')).toBe('tenant-1');
    expect(session.msUntilExpiry()).toBe(7 * 24 * 3600 * 1000);
    expect(session.isExpired()).toBe(false);
  });

  it('detects expiry and leaves a one-shot notice on expire()', () => {
    const { session } = make();
    session.setAuth({ token: 'abc', expires_at: '2026-11-21T09:59:59Z' });
    expect(session.isExpired()).toBe(true);
    session.expire();
    expect(session.getToken()).toBeNull();
    expect(session.consumeNotice()).toBe('session_expired');
    expect(session.consumeNotice()).toBeNull();
  });

  it('expire() is a no-op when signed out, clear() leaves no notice', () => {
    const { session } = make();
    session.expire();
    expect(session.peekNotice()).toBeNull();
    session.setAuth({ token: 'abc' });
    session.clear();
    expect(session.getToken()).toBeNull();
    expect(session.peekNotice()).toBeNull();
  });
});
