import type { ThemeConfig } from '@storeplix/types';
import fontsJson from '@storeplix/themes/fonts.json';
import defaultsJson from '@storeplix/themes/modern-commerce/defaults.json';
import manifestJson from '@storeplix/themes/modern-commerce/manifest.json';
import type { BlockDef, FieldDef, FontPairing, SectionDef, StylePreset, ThemeDefinition } from './types';

// Adapter over `@storeplix/themes` (owner SF, contract §4.1): schema.v1.json, defaults.json, manifest.json and
// fonts.json are the single source of truth. This file only reshapes the manifest for the editor form.

interface ManifestField extends FieldDef {
  showIf?: { key: string; equals: unknown };
  unit?: string;
}
interface ManifestPresetBlock {
  type: string;
  settings: Record<string, unknown>;
}
interface ManifestSection {
  type: string;
  label: string;
  maxInstances: number;
  usesSampleProducts?: boolean;
  fields: ManifestField[];
  blocks?: { type: string; label: string; max: number; fields: ManifestField[] };
  preset: { type: string; settings: Record<string, unknown>; blocks?: ManifestPresetBlock[] };
}
interface Manifest {
  name: string;
  version: string;
  limits: { maxSections: number; maxConfigBytes: number };
  sectionDesign: { fields: ManifestField[] };
  stylePresets: (StylePreset & { cornerStyle?: string })[];
  sections: ManifestSection[];
  sampleProductsNote: string;
}

const manifest = manifestJson as unknown as Manifest;

const descriptions: Record<string, string> = {
  hero: 'Big headline, photo and buttons at the top',
  'chip-links': 'A row of round shortcuts',
  'flash-sale': 'Deals with a countdown',
  'category-grid': 'Picture tiles that link to collections',
  'featured-products': 'New arrivals or bestsellers',
  'image-with-text': 'A photo with a short story',
  'feature-tiles': 'Up to three big tiles',
  'trust-badges': 'Delivery, payment and return promises',
  'reviews-club': 'Parent reviews and a club card',
  'rich-text': 'A heading and formatted text',
};

function blockDef(s: ManifestSection): (BlockDef & { max: number }) | undefined {
  if (!s.blocks) return undefined;
  const titleField = s.blocks.fields.find((f) => f.required && f.widget === 'text') ?? s.blocks.fields.find((f) => f.widget === 'text') ?? s.blocks.fields[0];
  return {
    type: s.blocks.type,
    label: s.blocks.label,
    max: s.blocks.max,
    titleKey: titleField?.key ?? 'title',
    fields: s.blocks.fields,
    defaults: structuredClone(s.preset.blocks?.[0]?.settings ?? {}),
  };
}

export const sections: SectionDef[] = manifest.sections.map((s) => ({
  type: s.type,
  label: s.label,
  description: descriptions[s.type] ?? '',
  maxInstances: s.maxInstances,
  fields: s.fields,
  block: blockDef(s),
  samplesProducts: !!s.usesSampleProducts,
  defaults: {
    // `design` comes separately (reducer merges `defaultDesign` with the preset's design).
    settings: structuredClone(s.preset.settings),
    ...(s.preset.blocks ? { blocks: s.preset.blocks.map((b) => structuredClone(b.settings)) } : {}),
  },
}));

/** Design tab fields; "Show on" (visibility) has its own control. */
export const designFields: FieldDef[] = manifest.sectionDesign.fields.filter((f) => (f.widget as string) !== 'visibility');

export const defaultDesign = {
  background: 'default',
  customBackground: null as string | null,
  textTone: 'auto',
  paddingTop: 64,
  paddingBottom: 48,
  visibility: { desktop: true, tablet: true, phone: true },
};

export const fonts: string[] = fontsJson.fonts.map((f) => f.family);

export const pairings: FontPairing[] = fontsJson.pairings.map((p) => ({ id: p.id, name: p.name, heading: p.headingFontFamily, body: p.fontFamily, hint: p.description }));

export const presets: StylePreset[] = manifest.stylePresets.map(({ id, name, primaryColor, secondaryColor, textColor, backgroundColor, pairing }) => ({
  id,
  name,
  primaryColor,
  secondaryColor,
  textColor,
  backgroundColor,
  pairing,
}));

export const defaults = defaultsJson as unknown as ThemeConfig;
export const sampleProductsNote = manifest.sampleProductsNote;

export const modernCommerce: ThemeDefinition = {
  code: 'modern-commerce',
  name: manifest.name,
  version: manifest.version,
  major: 1,
  limits: { maxSections: manifest.limits.maxSections, maxConfigBytes: manifest.limits.maxConfigBytes },
  fonts,
  pairings,
  presets,
  sections,
  designFields,
  defaults,
};
