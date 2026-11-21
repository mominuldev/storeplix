import defaultsJson from '@storeplix/themes/modern-commerce/defaults.json';
import type { ThemeDefinition } from '../types';
import { ComingSoon } from './coming-soon';
import { ModernCommerceLayout } from './layout';
import {
  badgeBlock,
  categoryBlock,
  categoryGridSchema,
  chipBlock,
  chipLinksSchema,
  featureTilesSchema,
  featuredProductsSchema,
  flashSaleSchema,
  heroSchema,
  imageWithTextSchema,
  modernCommerceSettingsSchema,
  reviewBlock,
  reviewsClubSchema,
  richTextSchema,
  statBlock,
  tileBlock,
  trustBadgesSchema,
  type ModernCommerceSettings,
} from './schema';
import { CategoryGridSection } from './sections/category-grid';
import { ChipLinksSection } from './sections/chip-links';
import { FeatureTilesSection } from './sections/feature-tiles';
import { FeaturedProductsSection } from './sections/featured-products';
import { FlashSaleSection } from './sections/flash-sale';
import { HeroSection } from './sections/hero';
import { ImageWithTextSection } from './sections/image-with-text';
import { ReviewsClubSection } from './sections/reviews-club';
import { RichTextSection } from './sections/rich-text';
import { TrustBadgesSection } from './sections/trust-badges';

/**
 * modern-commerce 1.1 ("Gallery"): Figma Storefront page 1:9207, home desktop 1:10112, tablet
 * 1:10482, mobile 1:10335. Section/block limits mirror packages/themes/modern-commerce/manifest.json.
 */
export const modernCommerce: ThemeDefinition<ModernCommerceSettings> = {
  id: 'modern-commerce',
  name: 'Gallery',
  version: '1.1.0',
  settingsSchema: modernCommerceSettingsSchema,
  defaults: defaultsJson as { sections: unknown[] },
  sections: {
    hero: { label: 'Hero', schema: heroSchema, blocks: { type: 'stat', max: 3, schema: statBlock }, Component: HeroSection },
    'chip-links': { label: 'Shop by age', schema: chipLinksSchema, blocks: { type: 'chip', max: 8, schema: chipBlock }, Component: ChipLinksSection },
    'flash-sale': { label: 'Flash sale', schema: flashSaleSchema, Component: FlashSaleSection },
    'category-grid': {
      label: 'Categories',
      schema: categoryGridSchema,
      blocks: { type: 'category', max: 8, schema: categoryBlock },
      Component: CategoryGridSection,
    },
    'featured-products': { label: 'Products', schema: featuredProductsSchema, Component: FeaturedProductsSection },
    'image-with-text': { label: 'Editorial', schema: imageWithTextSchema, Component: ImageWithTextSection },
    'feature-tiles': { label: 'Three worlds', schema: featureTilesSchema, blocks: { type: 'tile', max: 3, schema: tileBlock }, Component: FeatureTilesSection },
    'trust-badges': { label: 'Promises', schema: trustBadgesSchema, blocks: { type: 'badge', max: 4, schema: badgeBlock }, Component: TrustBadgesSection },
    'reviews-club': {
      label: 'Reviews & club',
      schema: reviewsClubSchema,
      blocks: { type: 'review', max: 6, schema: reviewBlock },
      Component: ReviewsClubSection,
    },
    'rich-text': { label: 'Text', schema: richTextSchema, Component: RichTextSection },
  },
  Layout: ModernCommerceLayout,
  ComingSoon,
};
