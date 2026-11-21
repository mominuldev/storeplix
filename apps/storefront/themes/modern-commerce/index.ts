import type { ThemeDefinition } from '../types';
import { ModernCommerceLayout } from './layout';
import { featuredProductsSchema, heroSchema, modernCommerceSettingsSchema, type ModernCommerceSettings } from './schema';
import { FeaturedProductsSection } from './sections/featured-products';
import { HeroSection } from './sections/hero';

export const modernCommerce: ThemeDefinition<ModernCommerceSettings> = {
  id: 'modern-commerce',
  name: 'Modern Commerce',
  version: '1.0.0',
  settingsSchema: modernCommerceSettingsSchema,
  sectionSchemas: {
    hero: heroSchema,
    'featured-products': featuredProductsSchema,
  },
  defaultSections: [
    { type: 'hero', enabled: true },
    { type: 'featured-products', enabled: true },
  ],
  Layout: ModernCommerceLayout,
  sections: {
    hero: HeroSection,
    'featured-products': FeaturedProductsSection,
  },
};
