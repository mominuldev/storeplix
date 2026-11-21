import bazaar from '../assets/themes/bazaar.jpg';
import boutique from '../assets/themes/boutique.jpg';
import classic from '../assets/themes/classic.jpg';
import festive from '../assets/themes/festive.jpg';
import gallery from '../assets/themes/gallery.jpg';
import kidsCorner from '../assets/themes/kids-corner.jpg';
import minimal from '../assets/themes/minimal.jpg';
import oneProduct from '../assets/themes/one-product.jpg';
import sareeHouse from '../assets/themes/saree-house.jpg';
import type { ThemeCatalogEntry, ThemeConfig } from '@storeplix/types';
import { getThemeDefinition } from './theme-package';

// Theme library thumbnails exported from Figma V3 Themes 2032:44893 (card "Thumbnail" frames, 352×236).
const byName: Record<string, string> = {
  gallery,
  boutique,
  bazaar,
  minimal,
  festive,
  'saree house': sareeHouse,
  'kids corner': kidsCorner,
  classic,
  'one product': oneProduct,
};

export function themeThumbnail(entry: Pick<ThemeCatalogEntry, 'name' | 'code'>): string | undefined {
  return byName[entry.name.toLowerCase()] ?? (entry.code === 'modern-commerce' ? gallery : undefined);
}

export function formatTaka(minor: number | null | undefined): string {
  if (minor == null) return '';
  return `৳${Math.round(minor / 100).toLocaleString('en-US')}`;
}

/** Human summary of a theme's style for the current-theme card. */
export function styleSummary(config: ThemeConfig | null | undefined) {
  if (!config) return null;
  const def = getThemeDefinition(config.theme);
  const s = config.settings;
  const preset = def?.presets.find((p) => p.id === s.stylePreset);
  const pairing = def?.pairings.find((p) => p.body === s.fontFamily && p.heading === s.headingFontFamily);
  return {
    colours: [s.primaryColor, s.textColor, s.secondaryColor, s.backgroundColor],
    colourName: preset?.name ?? 'Custom colours',
    fonts: pairing ? `${pairing.name} · ${s.headingFontFamily}` : `${s.headingFontFamily} · ${s.fontFamily}`,
    corners: s.cornerStyle.charAt(0).toUpperCase() + s.cornerStyle.slice(1),
  };
}
