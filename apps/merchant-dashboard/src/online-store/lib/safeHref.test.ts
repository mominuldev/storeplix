import { describe, expect, it } from 'vitest';
import { isSafeButtonHref, isSafeNavUrl, isSafeRichTextHref, isSafeThemeHref, slugify } from './safeHref';

const attacks = [
  'javascript:alert(1)',
  ' JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  '%6a%61vascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '//evil.com',
  '/\\evil.com',
  'https://user:pw@x.com',
  'vbscript:msgbox(1)',
  '/%0d%0aSet-Cookie:x',
  '/%2F%2Fevil.com',
  '',
];

describe('safe href validation (contract §8)', () => {
  it.each(attacks)('rejects %j everywhere', (href) => {
    expect(isSafeThemeHref(href)).toBe(false);
    expect(isSafeRichTextHref(href)).toBe(false);
    expect(isSafeNavUrl(href)).toBe(false);
    expect(isSafeButtonHref(href)).toBe(false);
  });

  it('theme hrefs: relative or https only', () => {
    expect(isSafeThemeHref('/collections/winter')).toBe(true);
    expect(isSafeThemeHref('https://facebook.com/shop')).toBe(true);
    expect(isSafeThemeHref('http://x.com')).toBe(false);
    expect(isSafeThemeHref('mailto:a@b.co')).toBe(false);
    expect(isSafeThemeHref('/a b')).toBe(false);
  });

  it('nav urls: http and https, never ftp', () => {
    expect(isSafeNavUrl('http://x.com')).toBe(true);
    expect(isSafeNavUrl('https://x.com/a?b=1')).toBe(true);
    expect(isSafeNavUrl('ftp://x.com')).toBe(false);
    expect(isSafeNavUrl('/relative')).toBe(false);
    expect(isSafeNavUrl(`https://x.com/${'a'.repeat(2050)}`)).toBe(false);
  });

  it('rich text adds strict mailto and tel', () => {
    expect(isSafeRichTextHref('mailto:hello@shop.com')).toBe(true);
    expect(isSafeRichTextHref('mailto:a@b.com?subject=x')).toBe(false);
    expect(isSafeRichTextHref('tel:+8801712345678')).toBe(true);
    expect(isSafeRichTextHref('tel:12')).toBe(false);
    expect(isSafeRichTextHref('http://x.com')).toBe(true);
  });

  it('page buttons allow wa.me and tel', () => {
    expect(isSafeButtonHref('https://wa.me/8801712345678')).toBe(true);
    expect(isSafeButtonHref('tel:01712345678')).toBe(true);
    expect(isSafeButtonHref('mailto:a@b.co')).toBe(false);
  });

  it('slugify', () => {
    expect(slugify('Delivery & Return Policy!')).toBe('delivery-and-return-policy');
    expect(slugify('ঈদ কালেকশন')).toBe('');
    expect(slugify('Café  Menu')).toBe('cafe-menu');
  });
});
