import { describe, expect, it } from 'vitest';
import { bearerToken, parseRevalidateBody, secretMatches } from '@/lib/revalidate';
import { storeTag } from '@/lib/cache-tags';

describe('revalidate helpers', () => {
  it('compares secrets safely', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true);
    expect(secretMatches('s3cret!', 's3cret')).toBe(false);
    expect(secretMatches('', 's3cret')).toBe(false);
    expect(secretMatches('anything', undefined)).toBe(false);
  });

  it('extracts bearer tokens', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer  abc ')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  it('normalizes hosts and rejects bad input', () => {
    expect(parseRevalidateBody({ host: 'Demo.Localhost:3000' })).toEqual({ hosts: ['demo.localhost'], skipped: [] });
    expect(parseRevalidateBody({ hosts: ['a.example.com', 'A.example.com.'] })).toEqual({ hosts: ['a.example.com'], skipped: [] });
    expect(parseRevalidateBody({ host: 'bad host' })).toBeNull();
    expect(parseRevalidateBody({ hosts: [] })).toBeNull();
    expect(parseRevalidateBody({ hosts: ['bad host', 42, ''] })).toBeNull();
    expect(parseRevalidateBody({ hosts: Array(51).fill('a.example.com') })).toBeNull();
    expect(parseRevalidateBody(null)).toBeNull();
    expect(storeTag('demo.localhost')).toBe('store:demo.localhost');
  });
});

import { originForHost } from '@/lib/seo';
describe('originForHost', () => {
  it('uses https for real domains and http+port for local dev hosts', () => {
    expect(originForHost('shop.example.com')).toBe('https://shop.example.com');
    expect(originForHost('demo.localhost')).toBe('http://demo.localhost:3010');
  });
});

describe('parseRevalidateBody: partial batches', () => {
  it('keeps valid hosts and reports the invalid ones', () => {
    expect(parseRevalidateBody({ hosts: ['demo.storeplix.com', 'bad host', 'shop.example.com.', 7, 'evil.com/x'] })).toEqual({
      hosts: ['demo.storeplix.com', 'shop.example.com'],
      skipped: ['bad host', '7', 'evil.com/x'],
    });
  });
});
