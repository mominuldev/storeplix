import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { mailtoHref, socialHref, telHref, whatsappHref } from '@/lib/contact';
import { isAllowedMediaOrigin, mediaRemotePatterns, parseMediaOrigins } from '@/lib/media';
import { sanitizeImageUrl } from '@/lib/sanitize';
import { contactItems, socialItems } from '@/themes/modern-commerce/components/contact';
import { Footer } from '@/themes/modern-commerce/footer';
import { ComingSoon } from '@/themes/modern-commerce/coming-soon';
import { resolveThemeConfig } from '@/themes/resolve';
import { modernCommerce } from '@/themes/modern-commerce';
import type { ModernCommerceSettings } from '@/themes/modern-commerce/schema';

const NO_CONTACT = { phone: null, email: null, whatsapp: null, support_hours: null };
const NO_SOCIAL = { facebook: null, instagram: null, youtube: null };

describe('contact link builders', () => {
  it('tel: keeps + and digits only', () => {
    expect(telHref('+8801712345678')).toBe('tel:+8801712345678');
    expect(telHref('017-1234 5678')).toBe('tel:01712345678');
    expect(telHref('javascript:alert(1)')).toBeNull();
    expect(telHref('123')).toBeNull();
    expect(telHref('+1 (555) 010-9999; x=1')).toBeNull();
  });

  it('WhatsApp becomes a wa.me link from digits only', () => {
    expect(whatsappHref('+880 1712-345678')).toBe('https://wa.me/8801712345678');
    expect(whatsappHref('https://evil.example/8801712345678')).toBeNull();
    expect(whatsappHref('data:text/html,1')).toBeNull();
  });

  it('mailto: rejects header injection and non-emails', () => {
    expect(mailtoHref('hello@shop.com')).toBe('mailto:hello@shop.com');
    expect(mailtoHref('a@b.com?cc=x@y.com')).toBeNull();
    expect(mailtoHref('a@b.com\nBcc: x@y.com')).toBeNull();
    expect(mailtoHref('javascript:alert(1)//@x.com')).toBeNull();
    expect(mailtoHref('not-an-email')).toBeNull();
  });

  it('social links: https only, per-network host allowlist', () => {
    expect(socialHref('facebook', 'https://facebook.com/demo')).toBe('https://facebook.com/demo');
    expect(socialHref('youtube', 'https://youtu.be/x')).toBe('https://youtu.be/x');
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'http://facebook.com/demo',
      'https://evil.example/facebook.com',
      'https://facebook.com.evil.example/x',
      'https://user:pw@facebook.com/x',
      '//facebook.com/x',
    ]) {
      expect(socialHref('facebook', bad), bad).toBeNull();
    }
    expect(socialHref('instagram', 'https://facebook.com/demo')).toBeNull();
  });

  it('builds only non-empty, valid items', () => {
    expect(contactItems(NO_CONTACT)).toEqual([]);
    expect(socialItems(NO_SOCIAL)).toEqual([]);
    const items = contactItems({ phone: '+8801712345678', email: 'bad email', whatsapp: null, support_hours: '10am–8pm' });
    expect(items.map((i) => i.key)).toEqual(['phone', 'hours']);
    expect(socialItems({ facebook: 'javascript:alert(1)', instagram: 'https://instagram.com/shop', youtube: null }).map((i) => i.key)).toEqual([
      'instagram',
    ]);
  });
});

describe('footer / coming soon rendering', () => {
  const settings = resolveThemeConfig(modernCommerce, undefined).settings as ModernCommerceSettings;
  const store = {
    id: '1', name: 'Demo Store', slug: 'demo', status: 'active' as const, currency: 'BDT',
    logo_url: null, favicon_url: null, icons: { apple_touch: null, icon_192: null, icon_512: null }, primary_host: 'demo.localhost',
  };

  it('renders contact + safe social links and drops unsafe ones', () => {
    const html = renderToStaticMarkup(
      createElement(Footer, {
        store, settings, description: null, menus: [],
        contact: { phone: '+8801712345678', email: 'hi@demo.com', whatsapp: '+8801712345678', support_hours: '10am–8pm' },
        social: { facebook: 'javascript:alert(1)', instagram: 'https://instagram.com/demo', youtube: 'data:text/html,x' },
      }),
    );
    expect(html).toContain('href="tel:+8801712345678"');
    expect(html).toContain('href="https://wa.me/8801712345678"');
    expect(html).toContain('href="mailto:hi@demo.com"');
    expect(html).toContain('10am–8pm');
    expect(html).toContain('href="https://instagram.com/demo" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text');
    expect(html).not.toContain('aria-label="Facebook"');
  });

  it('renders nothing for missing contact/social, and the store name when there is no logo', () => {
    const html = renderToStaticMarkup(createElement(Footer, { store, settings, description: null, menus: [], contact: NO_CONTACT, social: NO_SOCIAL }));
    expect(html).not.toContain('tel:');
    expect(html).not.toContain('mailto:');
    expect(html).not.toContain('aria-label="Instagram"');
    expect(html).toContain('Demo Store');
  });

  it('coming soon shows logo/name, contact and social', () => {
    const html = renderToStaticMarkup(
      createElement(ComingSoon, {
        store: { ...store, status: 'draft' as const, logo_url: 'https://cdn.storeplix.com/logo.webp' },
        settings,
        contact: { ...NO_CONTACT, email: 'hi@demo.com' },
        social: { ...NO_SOCIAL, youtube: 'https://youtube.com/@demo' },
      }),
    );
    expect(html).toContain('src="https://cdn.storeplix.com/logo.webp" alt="Demo Store"');
    expect(html).toContain('mailto:hi@demo.com');
    expect(html).toContain('https://youtube.com/@demo');
  });
});

describe('media origins (remotePatterns, no wildcard)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('parses exact origins and ignores junk/wildcards', () => {
    const origins = parseMediaOrigins('http://localhost:8000, https://cdn.storeplix.com ,https://*.evil.com,ftp://x,nope');
    expect(origins.map((o) => o.origin)).toEqual(['http://localhost:8000', 'https://cdn.storeplix.com']);
    expect(mediaRemotePatterns(origins)).toEqual([
      { protocol: 'http', hostname: 'localhost', port: '8000', pathname: '/**' },
      { protocol: 'https', hostname: 'cdn.storeplix.com', port: '', pathname: '/**' },
    ]);
    expect(parseMediaOrigins(undefined)).toEqual([]);
  });

  it('allows http images only from configured origins', () => {
    vi.stubEnv('STOREFRONT_MEDIA_ORIGINS', 'http://localhost:8000');
    expect(isAllowedMediaOrigin('http://localhost:8000/storage/a.png')).toBe(true);
    expect(sanitizeImageUrl('http://localhost:8000/storage/a.png')).toBe('http://localhost:8000/storage/a.png');
    expect(sanitizeImageUrl('http://localhost:9999/a.png')).toBeNull();
    expect(sanitizeImageUrl('http://evil.example/a.png')).toBeNull();
    expect(sanitizeImageUrl('data:image/png;base64,AAAA')).toBeNull();
  });
});
