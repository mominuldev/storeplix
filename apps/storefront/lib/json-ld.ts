import type { SocialLinks, StoreContact } from '@storeplix/types';
import { socialHref, telHref } from './contact';
import { sanitizeImageUrl } from './sanitize';

/**
 * JSON for a `<script type="application/ld+json">`: JSON.stringify, then escape every character
 * that could end the script element or confuse the HTML parser (`<`, `>`, `&`) and the JS line
 * terminators U+2028/U+2029. The result contains no `<`, so `</script>` can't appear.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Organization + WebSite JSON-LD for a live store (no SearchAction until /search exists). */
export function storeJsonLd(input: {
  name: string;
  origin: string;
  logoUrl: string | null;
  contact: StoreContact;
  social: SocialLinks;
}): object[] {
  const url = `${input.origin}/`;
  const logo = sanitizeImageUrl(input.logoUrl);
  const sameAs = (['facebook', 'instagram', 'youtube'] as const).flatMap((n) => {
    const href = socialHref(n, input.social[n]);
    return href ? [href] : [];
  });
  const tel = telHref(input.contact.phone);
  const organization: Record<string, unknown> = { '@context': 'https://schema.org', '@type': 'Organization', name: input.name, url };
  if (logo) organization.logo = logo;
  if (sameAs.length) organization.sameAs = sameAs;
  if (tel) organization.contactPoint = { '@type': 'ContactPoint', telephone: tel.slice(4), contactType: 'customer service' };
  return [organization, { '@context': 'https://schema.org', '@type': 'WebSite', name: input.name, url }];
}
