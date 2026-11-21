import { describe, expect, it } from 'vitest';
import { isTrustedProxy, normalizeHost, resolveRequestHost } from '@/lib/host';

const h = (record: Record<string, string>) => new Headers(record);

describe('normalizeHost', () => {
  it.each([
    ['demo.localhost:3000', 'demo.localhost'],
    ['Demo.StorePlix.COM', 'demo.storeplix.com'],
    ['shop.example.com.', 'shop.example.com'],
    ['SHOP.example.com.:443', 'shop.example.com'],
    ['  demo.storeplix.test  ', 'demo.storeplix.test'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['localhost', 'localhost'],
    ['storefront:3000', 'storefront'],
    ['a-b.c-d.example', 'a-b.c-d.example'],
  ])('normalizes %j -> %j', (raw, expected) => {
    expect(normalizeHost(raw)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['.'],
    ['..example.com'],
    ['example..com'],
    ['-bad.example.com'],
    ['bad-.example.com'],
    ['exa_mple.com'],
    ['exa mple.com'],
    ['user@example.com'],
    ['example.com/path'],
    ['example.com\\evil.com'],
    ['example.com:'],
    ['example.com:abc'],
    ['example.com:0'],
    ['example.com:70000'],
    ['example.com:80:80'],
    ['[::1]:3000'],
    ['::1'],
    ['127.0.0.1'],
    ['10.0.0.5:8080'],
    ['bücher.example'],
    ['example.com,evil.com'],
    ['example.com\r\nX-Injected: 1'],
    [`${'a'.repeat(64)}.example.com`],
    [`${'a.'.repeat(127)}com`],
  ])('rejects %j', (raw) => {
    expect(normalizeHost(raw)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost(undefined)).toBeNull();
  });
});

describe('resolveRequestHost', () => {
  it('uses the Host header', () => {
    expect(resolveRequestHost(h({ host: 'demo.localhost:3000' }))).toBe('demo.localhost');
  });

  it('ignores X-Forwarded-Host by default (spoofing attempt)', () => {
    const headers = h({ host: 'demo.localhost:3000', 'x-forwarded-host': 'victim.storeplix.com' });
    expect(resolveRequestHost(headers)).toBe('demo.localhost');
    expect(resolveRequestHost(headers, { trustedProxy: false })).toBe('demo.localhost');
  });

  it('does not fall back to X-Forwarded-Host when Host is malformed and proxy is untrusted', () => {
    const headers = h({ host: 'bad host', 'x-forwarded-host': 'victim.storeplix.com' });
    expect(resolveRequestHost(headers)).toBeNull();
  });

  it('honours X-Forwarded-Host (left-most value) only when TRUSTED_PROXY is set', () => {
    const headers = h({ host: 'internal:3000', 'x-forwarded-host': 'Shop.Example.com, internal' });
    expect(resolveRequestHost(headers, { trustedProxy: true })).toBe('shop.example.com');
  });

  it('rejects a malformed forwarded host even when trusted', () => {
    const headers = h({ host: 'demo.localhost', 'x-forwarded-host': 'evil.com/../x' });
    expect(resolveRequestHost(headers, { trustedProxy: true })).toBeNull();
  });

  it('falls back to Host when trusted proxy sends no forwarded header', () => {
    expect(resolveRequestHost(h({ host: 'demo.localhost' }), { trustedProxy: true })).toBe('demo.localhost');
  });

  it('returns null without a Host header', () => {
    expect(resolveRequestHost(h({}))).toBeNull();
  });
});

describe('isTrustedProxy', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['', false],
    ['yes', false],
    [undefined, false],
  ])('%j -> %j', (value, expected) => {
    expect(isTrustedProxy(value)).toBe(expected);
  });
});
