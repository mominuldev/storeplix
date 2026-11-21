import { z } from 'zod';
import {
  boolField,
  colorField,
  fontField,
  hrefField,
  imageField,
  intField,
  optionalHrefField,
  optionalTextField,
  settingsObject,
  textField,
} from '../schema-helpers';

export const DEFAULT_PRIMARY = '#0846c2';
export const DEFAULT_SECONDARY = '#ff7a00';

const navLink = z.object({ label: z.string().trim().min(1).max(40), href: hrefField('/') });
const navLinks = (def: Array<{ label: string; href: string }>, max: number) =>
  z
    .array(z.unknown())
    .max(50)
    .transform((items) =>
      items.flatMap((item) => {
        const r = navLink.safeParse(item);
        return r.success ? [r.data] : [];
      }).slice(0, max),
    )
    .catch(def);

const DEFAULT_NAV = [
  { label: 'New arrivals', href: '/collections/new' },
  { label: 'Clothing', href: '/collections/clothing' },
  { label: 'Toys & learning', href: '/collections/toys' },
  { label: 'Essentials', href: '/collections/essentials' },
  { label: 'Gifts', href: '/collections/gifts' },
];

const DEFAULT_PAYMENT_METHODS = ['Cash on delivery', 'bKash', 'Nagad', 'Visa', 'Mastercard'];

/** Global settings for modern-commerce v1. Every field self-heals to its default. */
export const modernCommerceSettingsSchema = settingsObject({
  primaryColor: colorField(DEFAULT_PRIMARY),
  secondaryColor: colorField(DEFAULT_SECONDARY),
  fontFamily: fontField('Instrument Sans'),
  headingFontFamily: fontField('Fraunces'),
  announcement: textField('Cash on delivery nationwide', 120),
  navigation: navLinks(DEFAULT_NAV, 8),
  promoLink: z.object({ label: z.string().trim().min(1).max(40), href: hrefField('/') }).optional().catch(undefined),
  footerTagline: optionalTextField(240),
  paymentMethods: z.array(z.string().trim().min(1).max(30)).max(8).catch(DEFAULT_PAYMENT_METHODS),
});
export type ModernCommerceSettings = z.infer<typeof modernCommerceSettingsSchema>;

const stat = z.object({ value: z.string().trim().min(1).max(12), label: z.string().trim().min(1).max(40) });

export const heroSchema = settingsObject({
  eyebrow: optionalTextField(40).transform((v) => v ?? 'New collection'),
  heading: textField('Little things,', 60),
  headingAccent: optionalTextField(60).transform((v) => v ?? 'chosen well.'),
  subheading: textField(
    'Everything you love, gathered in one calm, carefully edited store - delivered to your door.',
    280,
  ),
  primaryCtaLabel: textField('Shop new arrivals', 30),
  primaryCtaHref: hrefField('/collections/new'),
  secondaryCtaLabel: optionalTextField(30),
  secondaryCtaHref: optionalHrefField(),
  image: imageField('/themes/modern-commerce/images/hero-main.png'),
  imageAlt: textField('', 160),
  detailImage: imageField('/themes/modern-commerce/images/cardigan.png'),
  tagLabel: optionalTextField(24).transform((v) => v ?? 'New season'),
  ratingLabel: optionalTextField(40),
  showFeaturedProduct: boolField(true),
  stats: z
    .array(z.unknown())
    .max(10)
    .transform((items) => items.flatMap((i) => (stat.safeParse(i).success ? [stat.parse(i)] : [])).slice(0, 3))
    .catch([]),
});
export type HeroSettings = z.infer<typeof heroSchema>;

export const featuredProductsSchema = settingsObject({
  eyebrow: optionalTextField(40).transform((v) => v ?? 'Just landed'),
  title: textField('New arrivals', 60),
  linkLabel: optionalTextField(30).transform((v) => v ?? 'Shop all new'),
  linkHref: hrefField('/collections/new'),
  limit: intField(4, 1, 8),
});
export type FeaturedProductsSettings = z.infer<typeof featuredProductsSchema>;
