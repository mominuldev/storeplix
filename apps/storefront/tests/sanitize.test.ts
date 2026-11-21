import { describe, expect, it } from 'vitest';
import { readableInk, sanitizeColor, sanitizeHref, sanitizeImageUrl } from '@/lib/sanitize';

describe('sanitizeColor', () => {
  it.each([
    ['#fff', '#fff'],
    ['#FFF', '#fff'],
    ['#0846C2', '#0846c2'],
    ['#0846c2cc', '#0846c2cc'],
    ['#abcd', '#abcd'],
    ['  #123456  ', '#123456'],
    ['rgb(8, 70, 194)', 'rgb(8, 70, 194)'],
    ['rgb(8 70 194)', 'rgb(8, 70, 194)'],
    ['RGBA(8,70,194,0.5)', 'rgba(8, 70, 194, 0.5)'],
    ['rgb(8 70 194 / 50%)', 'rgba(8, 70, 194, 0.5)'],
    ['rgba(0,0,0,1)', 'rgba(0, 0, 0, 1)'],
  ])('accepts %j', (input, expected) => {
    expect(sanitizeColor(input)).toBe(expected);
  });

  it.each([
    'red',
    'transparent',
    '#ggg',
    '#12345',
    '#1234567',
    '123456',
    'rgb(256, 0, 0)',
    'rgb(-1, 0, 0)',
    'rgba(0,0,0,1.5)',
    'rgb(0,0)',
    'hsl(0, 100%, 50%)',
    'var(--x)',
    'calc(1px)',
    '#fff; background:url(https://evil.example/x)',
    'rgb(0,0,0); } body { display:none',
    'url(javascript:alert(1))',
    'expression(alert(1))',
    '</style><script>alert(1)</script>',
    '#f ff',
    '',
  ])('rejects %j', (input) => {
    expect(sanitizeColor(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(sanitizeColor(0x0846c2)).toBeNull();
    expect(sanitizeColor({ toString: () => '#fff' })).toBeNull();
    expect(sanitizeColor(null)).toBeNull();
  });
});

describe('readableInk', () => {
  it('uses light ink on dark brand and dark ink on light brand', () => {
    expect(readableInk('#0846c2', '#fffcf8', '#0e1a33')).toBe('#fffcf8');
    expect(readableInk('#ffe14d', '#fffcf8', '#0e1a33')).toBe('#0e1a33');
  });
});

describe('sanitizeHref', () => {
  it.each(['/collections/new', '/search?q=toys', 'https://facebook.com/demo'])('accepts %j', (v) => {
    expect(sanitizeHref(v)).not.toBeNull();
  });
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://insecure.example',
    '//evil.example',
    '/\\evil.example',
    'vbscript:msgbox',
    'java\tscript:alert(1)',
    'relative/path',
  ])('rejects %j', (v) => {
    expect(sanitizeHref(v)).toBeNull();
  });
});

describe('sanitizeImageUrl', () => {
  it('allows https and bundled theme assets only', () => {
    expect(sanitizeImageUrl('https://cdn.storeplix.com/a.png')).toBe('https://cdn.storeplix.com/a.png');
    expect(sanitizeImageUrl('/themes/modern-commerce/images/hero-main.png')).toBe('/themes/modern-commerce/images/hero-main.png');
    expect(sanitizeImageUrl('/api/revalidate')).toBeNull();
    expect(sanitizeImageUrl('/themes/../api/x')).toBeNull();
    expect(sanitizeImageUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
  });
});
