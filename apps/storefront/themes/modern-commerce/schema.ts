import { z } from 'zod';
import type { PaymentMethodBadge, RichTextDoc } from '@storeplix/types';
import defaultsJson from '@storeplix/themes/modern-commerce/defaults.json';
import { normalizeRichText } from '@/lib/rich-text';
import { DEFAULT_DESIGN, designSchema, type SectionDesign } from '../design';
import {
  boolField,
  cleanText,
  enumField,
  field,
  fontField,
  hexField,
  hrefField,
  intField,
  isPlainObject,
  markFallback,
  mediaIdField,
  nullableHrefField,
  nullableTextField,
  optionalHrefField,
  reqTextField,
  settingsObject,
  textField,
} from '../schema-helpers';
import { sanitizeHref } from '@/lib/sanitize';
import type { FontFamilyName } from '../fonts';
import type { CornerStyle } from '../types';

/**
 * Self-healing Zod mirror of packages/themes/modern-commerce/schema.v1.json (the source of truth).
 * Defaults come from defaults.json so a legacy section without settings renders the Figma copy.
 * Parity with the JSON Schema is proven by the shared fixtures (packages/themes tests).
 */
type Json = Record<string, unknown>;
const D = defaultsJson as unknown as { settings: Json; sections: Array<{ type: string; settings: Json; blocks?: unknown[] }> };
const G = D.settings as {
  primaryColor: string; secondaryColor: string; textColor: string; backgroundColor: string;
  fontFamily: FontFamilyName; headingFontFamily: FontFamilyName; cornerStyle: CornerStyle; buttonStyle: 'solid' | 'outline';
  announcement: { enabled: boolean; text: string; href: string | null };
  header: { sticky: boolean; showSearch: boolean; promoLink: { label: string; href: string } | null };
  footer: { tagline: string | null; showPaymentMethods: boolean; paymentMethods: PaymentMethodBadge[] };
};

/** Default settings of the first section of `type` in defaults.json. */
function sectionDefaults(type: string): Json & { design: SectionDesign } {
  const s = D.sections.find((x) => x.type === type)?.settings ?? {};
  return { ...s, design: (s.design as SectionDesign | undefined) ?? DEFAULT_DESIGN };
}
const str = (o: Json, k: string, def = ''): string => (typeof o[k] === 'string' ? (o[k] as string) : def);

export const DEFAULT_PRIMARY = G.primaryColor;
export const DEFAULT_SECONDARY = G.secondaryColor;

const PAYMENT_METHODS = ['cod', 'bkash', 'nagad', 'rocket', 'upay', 'visa', 'mastercard', 'amex'] as const;
const STYLE_PRESETS = ['mugdho-violet', 'jamdani-green', 'eid-gold', 'rose-blush', 'midnight', 'fresh-market', 'ocean', 'terracotta'] as const;

const objectOf = <S extends z.ZodRawShape>(shape: S) => settingsObject(shape);

// ---------- global settings ----------
export const modernCommerceSettingsSchema = settingsObject({
  primaryColor: hexField(G.primaryColor),
  secondaryColor: hexField(G.secondaryColor),
  textColor: hexField(G.textColor),
  backgroundColor: hexField(G.backgroundColor),
  fontFamily: fontField(G.fontFamily),
  headingFontFamily: fontField(G.headingFontFamily),
  cornerStyle: enumField(['square', 'rounded', 'pill'] as const, G.cornerStyle),
  buttonStyle: enumField(['solid', 'outline'] as const, G.buttonStyle),
  stylePreset: field<string | null>((v) => (v === null ? null : STYLE_PRESETS.includes(v as never) ? (v as string) : undefined), null),
  logoOnDarkMediaId: mediaIdField(),
  // Phase 2 configs stored the announcement as a plain string.
  announcement: z.preprocess(
    (v) => (typeof v === 'string' ? { enabled: true, text: v, href: null } : v),
    objectOf({
      enabled: boolField(G.announcement.enabled),
      text: textField(G.announcement.text, 120),
      href: nullableHrefField(),
    }),
  ),
  header: objectOf({
    sticky: boolField(G.header.sticky),
    showSearch: boolField(G.header.showSearch),
    promoLink: field<{ label: string; href: string } | null>((v) => {
      if (v === null) return null;
      if (!isPlainObject(v)) return undefined;
      const label = cleanText(v.label, 30, 1);
      const href = sanitizeHref(v.href);
      return label && href ? { label, href } : undefined;
    }, G.header.promoLink),
  }),
  footer: objectOf({
    tagline: nullableTextField(G.footer.tagline, 240),
    showPaymentMethods: boolField(G.footer.showPaymentMethods),
    paymentMethods: field<PaymentMethodBadge[]>((v) => {
      if (!Array.isArray(v) || v.length > 8) return undefined;
      if (!v.every((m) => PAYMENT_METHODS.includes(m))) return undefined;
      return new Set(v).size === v.length ? (v as PaymentMethodBadge[]) : undefined;
    }, G.footer.paymentMethods),
  }),
});
export type ModernCommerceSettings = z.infer<typeof modernCommerceSettingsSchema>;

// ---------- blocks ----------
/**
 * Block settings: `required` keys must be present and valid, otherwise the whole block is dropped
 * (and recorded as a fallback) instead of rendering with an invented link or label.
 */
function blockSchema<S extends z.ZodRawShape>(shape: S, required: Array<keyof S>) {
  return settingsObject(shape).transform((v) => {
    const out = v as Json;
    if (required.some((k) => out[k as string] === null || out[k as string] === undefined || out[k as string] === '')) {
      markFallback();
      return null;
    }
    return out;
  });
}
const reqBlockText = (max: number) => field<string | null>((v) => cleanText(v, max, 1), null);
const reqBlockHref = () => field<string | null>((v) => sanitizeHref(v) ?? undefined, null);

export const statBlock = blockSchema({ value: reqBlockText(12), label: reqBlockText(40) }, ['value', 'label']);
export const chipBlock = blockSchema(
  { badge: textField('', 6), label: reqBlockText(24), sublabel: textField('', 24), href: reqBlockHref() },
  ['label', 'href'],
);
export const categoryBlock = blockSchema({ title: reqBlockText(40), imageMediaId: mediaIdField(), href: reqBlockHref() }, ['title', 'href']);
export const tileBlock = blockSchema(
  { title: reqBlockText(40), text: textField('', 140), imageMediaId: mediaIdField(), href: reqBlockHref(), linkLabel: textField('', 30) },
  ['title', 'href'],
);
const BADGE_ICONS = ['truck', 'cash', 'return', 'shield', 'chat', 'gift', 'star', 'leaf'] as const;
export type BadgeIcon = (typeof BADGE_ICONS)[number];
export const badgeBlock = blockSchema(
  {
    icon: field<BadgeIcon | null>((v) => (BADGE_ICONS.includes(v as never) ? (v as BadgeIcon) : undefined), null),
    title: reqBlockText(40),
    text: textField('', 100),
  },
  ['icon', 'title'],
);
export const reviewBlock = blockSchema(
  { quote: reqBlockText(280), author: reqBlockText(40), location: textField('', 40), rating: intField(5, 1, 5) },
  ['quote', 'author'],
);

export interface StatBlock { value: string; label: string }
export interface ChipBlock { badge: string; label: string; sublabel: string; href: string }
export interface CategoryBlock { title: string; imageMediaId: string | null; href: string }
export interface TileBlock { title: string; text: string; imageMediaId: string | null; href: string; linkLabel: string }
export interface BadgeBlock { icon: BadgeIcon; title: string; text: string }
export interface ReviewBlock { quote: string; author: string; location: string; rating: number }

// ---------- sections ----------
const withDesign = <S extends z.ZodRawShape>(type: string, shape: S) =>
  settingsObject({ ...shape, design: designSchema(sectionDefaults(type).design) });

const hero = sectionDefaults('hero');
export const heroSchema = withDesign('hero', {
  eyebrow: textField(str(hero, 'eyebrow'), 40),
  heading: reqTextField(str(hero, 'heading', 'Welcome'), 60),
  headingAccent: textField(str(hero, 'headingAccent'), 60),
  subheading: textField(str(hero, 'subheading'), 140),
  primaryCtaLabel: textField(str(hero, 'primaryCtaLabel'), 30),
  primaryCtaHref: hrefField(str(hero, 'primaryCtaHref', '/')),
  secondaryCtaLabel: textField(str(hero, 'secondaryCtaLabel'), 30),
  secondaryCtaHref: optionalHrefField(str(hero, 'secondaryCtaHref') || null),
  imageMediaId: mediaIdField(),
  imageAlt: textField(str(hero, 'imageAlt'), 160),
  detailImageMediaId: mediaIdField(),
  tagLabel: textField(str(hero, 'tagLabel'), 24),
  showFeaturedProduct: boolField(hero.showFeaturedProduct !== false),
  layout: enumField(['image_right', 'image_left', 'full_image'] as const, 'image_right'),
  height: enumField(['fit', 'half', 'full'] as const, 'fit'),
});
export type HeroSettings = z.infer<typeof heroSchema>;

const chips = sectionDefaults('chip-links');
export const chipLinksSchema = withDesign('chip-links', { title: textField(str(chips, 'title'), 60), subtitle: textField(str(chips, 'subtitle'), 60) });
export type ChipLinksSettings = z.infer<typeof chipLinksSchema>;

const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const flash = sectionDefaults('flash-sale');
export const flashSaleSchema = withDesign('flash-sale', {
  eyebrow: textField(str(flash, 'eyebrow'), 24),
  title: reqTextField(str(flash, 'title', 'Flash sale'), 60),
  subtitle: textField(str(flash, 'subtitle'), 140),
  endsAt: field<string | null>((v) => (v === null ? null : typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined), null),
  linkLabel: textField(str(flash, 'linkLabel'), 30),
  linkHref: optionalHrefField(str(flash, 'linkHref') || null),
  limit: intField(4, 1, 8),
});
export type FlashSaleSettings = z.infer<typeof flashSaleSchema>;

const cats = sectionDefaults('category-grid');
export const categoryGridSchema = withDesign('category-grid', { title: textField(str(cats, 'title'), 60), subtitle: textField(str(cats, 'subtitle'), 140) });
export type CategoryGridSettings = z.infer<typeof categoryGridSchema>;

const fp = sectionDefaults('featured-products');
export const featuredProductsSchema = withDesign('featured-products', {
  eyebrow: textField(str(fp, 'eyebrow'), 40),
  title: reqTextField(str(fp, 'title', 'New arrivals'), 60),
  linkLabel: textField(str(fp, 'linkLabel'), 30),
  linkHref: optionalHrefField(str(fp, 'linkHref') || null),
  source: enumField(['latest', 'bestsellers'] as const, 'latest'),
  limit: intField(4, 1, 8),
});
export type FeaturedProductsSettings = z.infer<typeof featuredProductsSchema>;

const iwt = sectionDefaults('image-with-text');
export const imageWithTextSchema = withDesign('image-with-text', {
  eyebrow: textField(str(iwt, 'eyebrow'), 40),
  heading: reqTextField(str(iwt, 'heading', 'Our story'), 80),
  text: textField(str(iwt, 'text'), 400),
  ctaLabel: textField(str(iwt, 'ctaLabel'), 30),
  ctaHref: optionalHrefField(str(iwt, 'ctaHref') || null),
  imageMediaId: mediaIdField(),
  imageAlt: textField(str(iwt, 'imageAlt'), 160),
  layout: enumField(['image_left', 'image_right'] as const, 'image_right'),
});
export type ImageWithTextSettings = z.infer<typeof imageWithTextSchema>;

const tiles = sectionDefaults('feature-tiles');
export const featureTilesSchema = withDesign('feature-tiles', { title: textField(str(tiles, 'title'), 60), subtitle: textField(str(tiles, 'subtitle'), 140) });
export type FeatureTilesSettings = z.infer<typeof featureTilesSchema>;

export const trustBadgesSchema = withDesign('trust-badges', {});
export type TrustBadgesSettings = z.infer<typeof trustBadgesSchema>;

const rc = sectionDefaults('reviews-club');
const club = (isPlainObject(rc.club) ? rc.club : {}) as Json;
export const reviewsClubSchema = withDesign('reviews-club', {
  title: textField(str(rc, 'title'), 60),
  subtitle: textField(str(rc, 'subtitle'), 140),
  club: settingsObject({
    enabled: boolField(club.enabled !== false),
    heading: textField(str(club, 'heading'), 60),
    text: textField(str(club, 'text'), 200),
    ctaLabel: textField(str(club, 'ctaLabel'), 30),
    ctaHref: optionalHrefField(str(club, 'ctaHref') || null),
  }),
});
export type ReviewsClubSettings = z.infer<typeof reviewsClubSchema>;

const EMPTY_DOC: RichTextDoc = { type: 'doc', content: [] };
const RICH_TEXT_MAX_BYTES = 10 * 1024;
export const richTextSchema = withDesign('rich-text', {
  heading: nullableTextField(null, 80),
  doc: field<RichTextDoc>((v) => {
    if (JSON.stringify(v).length > RICH_TEXT_MAX_BYTES * 2) return undefined;
    const { doc, dropped } = normalizeRichText(v);
    if (dropped) markFallback();
    return doc;
  }, EMPTY_DOC),
  align: enumField(['left', 'center'] as const, 'left'),
  width: enumField(['narrow', 'wide'] as const, 'narrow'),
});
export type RichTextSettings = z.infer<typeof richTextSchema>;
