import type { ComponentType, ReactNode } from 'react';
import type { z } from 'zod';
import type { SocialLinks, StoreContact, StorefrontMedia } from '@storeplix/types';
import type { RawStorefrontConfig } from '@/lib/storefront-api';
import type { StorefrontNavigation } from '@/lib/storefront-schemas';
import type { SectionDesign } from './design';

/** Store data every theme component may read. Render-only; never includes secrets. */
export type ThemeStore = RawStorefrontConfig['store'];

export type CornerStyle = 'square' | 'rounded' | 'pill';

/** Validated, sanitized global theme settings shared by all themes. */
export interface BaseThemeSettings {
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  backgroundColor: string;
  fontFamily: string;
  headingFontFamily: string;
  cornerStyle: CornerStyle;
}

export interface ResolvedBlock<TSettings = Record<string, unknown>> {
  id: string;
  type: string;
  settings: TSettings;
}

export interface ResolvedSection<TSettings = Record<string, unknown>> {
  /** Section id from the config (or `type-index` for legacy configs without ids). Stable React key. */
  id: string;
  type: string;
  enabled: boolean;
  settings: TSettings & { design: SectionDesign };
  blocks: ResolvedBlock[];
}

export interface ResolvedThemeConfig<TSettings extends BaseThemeSettings = BaseThemeSettings> {
  theme: string;
  version: string;
  settings: TSettings;
  sections: ResolvedSection[];
  /** True when any part of the merchant config was rejected and replaced by defaults. */
  usedFallback: boolean;
}

/** Per-request data a section may use. */
export interface SectionContext {
  store: ThemeStore;
  /** Normalized request host (tenant key) for data lookups. */
  host: string;
  /** Media referenced by the served theme config (`StorefrontConfig.media`). */
  media: Record<string, StorefrontMedia>;
  /** Valid merchant preview (mode 'preview'): data lookups forward the preview token, uncached. */
  preview: boolean;
}

export interface SectionProps<TSettings = Record<string, unknown>, TBlock = Record<string, unknown>> {
  id: string;
  settings: TSettings & { design: SectionDesign };
  blocks: Array<ResolvedBlock<TBlock>>;
  ctx: SectionContext;
}

export interface SectionDefinition {
  /** Editor label (manifest). */
  label: string;
  /** Zod schema for `section.settings` (without `design`, which is shared). Must never throw. */
  schema: z.ZodType<Record<string, unknown>, unknown>;
  blocks?: {
    type: string;
    max: number;
    /** Zod schema for one block's `settings`; returns null when a required field is unusable. */
    schema: z.ZodType<Record<string, unknown> | null, unknown>;
  };
  // Section props are validated by the matching schema before render.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: ComponentType<SectionProps<any, any>>;
}

/** Public contact + social for the store (all nullable; links are validated at render). */
export interface ThemeContact {
  contact: StoreContact;
  social: SocialLinks;
}

export interface LayoutProps<TSettings extends BaseThemeSettings = BaseThemeSettings> extends ThemeContact {
  store: ThemeStore;
  settings: TSettings;
  navigation: StorefrontNavigation;
  /** Store SEO description, usable as footer copy. */
  description: string | null;
  children: ReactNode;
}

export interface ThemeDefinition<TSettings extends BaseThemeSettings = BaseThemeSettings> {
  id: string;
  name: string;
  /** Semver. Merchant configs with a different major version fall back to defaults. */
  version: string;
  /** Zod schema for global settings. Must never throw: invalid fields fall back to defaults. */
  settingsSchema: z.ZodType<TSettings, unknown>;
  sections: Record<string, SectionDefinition>;
  /** Raw default config (packages/themes/<id>/defaults.json): home sections, default blocks. */
  defaults: { sections: unknown[] };
  Layout: ComponentType<LayoutProps<TSettings>>;
  /** Full-page "Coming soon" shown on every path of a draft store (contract D2). */
  ComingSoon: ComponentType<{ store: ThemeStore; settings: TSettings } & ThemeContact>;
}
