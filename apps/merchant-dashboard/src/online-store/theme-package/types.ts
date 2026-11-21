import type { ThemeConfig } from '@storeplix/types';

// Editor metadata shape (contract §4.1 `manifest.json`: section catalog, field order/labels/widgets, presets, limits).
// `@storeplix/themes` (owner SF) is the source of truth; until it ships, `./modern-commerce.ts` mirrors §4.3.

export type FieldWidget =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'link'
  | 'image'
  | 'select'
  | 'segmented'
  | 'toggle'
  | 'slider'
  | 'number'
  | 'color'
  | 'datetime';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  /** Dot path inside `settings` (e.g. `club.heading`). */
  key: string;
  label: string;
  widget: FieldWidget;
  required?: boolean;
  maxLength?: number;
  options?: FieldOption[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  /** For `image`: the sibling alt-text key. */
  altKey?: string;
}

export interface BlockDef {
  type: string;
  label: string;
  /** Field shown as the block's title in the list. */
  titleKey: string;
  fields: FieldDef[];
  defaults: Record<string, unknown>;
}

export interface SectionDef {
  type: string;
  label: string;
  description: string;
  maxInstances: number;
  /** Content-tab fields (Design tab fields are common, see `designFields`). */
  fields: FieldDef[];
  block?: BlockDef & { max: number };
  /** Product-driven sections render placeholder products until Phase 5 (contract §0). */
  samplesProducts?: boolean;
  defaults: { settings: Record<string, unknown>; blocks?: Record<string, unknown>[] };
}

export interface StylePreset {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  backgroundColor: string;
  pairing: string;
}

export interface FontPairing {
  id: string;
  name: string;
  body: string;
  heading: string;
  hint: string;
}

export interface ThemeDefinition {
  code: string;
  name: string;
  version: string;
  major: number;
  limits: { maxSections: number; maxConfigBytes: number };
  fonts: string[];
  pairings: FontPairing[];
  presets: StylePreset[];
  sections: SectionDef[];
  designFields: FieldDef[];
  defaults: ThemeConfig;
}
