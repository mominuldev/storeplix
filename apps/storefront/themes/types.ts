import type { ComponentType, ReactNode } from 'react';
import type { z } from 'zod';
import type { RawStorefrontConfig } from '@/lib/storefront-api';

/** Store data every theme component may read. Render-only; never includes secrets. */
export type ThemeStore = RawStorefrontConfig['store'];

/** Validated, sanitized global theme settings shared by all themes. */
export interface BaseThemeSettings {
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  headingFontFamily: string;
}

export interface ResolvedSection<TSettings = Record<string, unknown>> {
  /** Stable key for React lists (type + position). */
  key: string;
  type: string;
  enabled: boolean;
  settings: TSettings;
}

export interface ResolvedThemeConfig<TSettings extends BaseThemeSettings = BaseThemeSettings> {
  theme: string;
  version: string;
  settings: TSettings;
  sections: ResolvedSection[];
  /** True when any part of the merchant config was rejected and replaced by defaults. */
  usedFallback: boolean;
}

export interface SectionProps<TSettings = Record<string, unknown>> {
  settings: TSettings;
  store: ThemeStore;
  /** Normalized request host (tenant key) for data lookups. */
  host: string;
}

export interface LayoutProps<TSettings extends BaseThemeSettings = BaseThemeSettings> {
  store: ThemeStore;
  settings: TSettings;
  /** Store SEO description, usable as footer copy. */
  description: string | null;
  children: ReactNode;
}

export interface ThemeDefinition<TSettings extends BaseThemeSettings = BaseThemeSettings> {
  id: string;
  name: string;
  /** Semver. Merchant configs with a different major version fall back to defaults. */
  version: string;
  /** Zod schema for global settings. Must never throw: invalid fields `.catch()` to defaults. */
  settingsSchema: z.ZodType<TSettings, unknown>;
  /** Zod schema per section type for that section's `settings`; must also `.catch()`. */
  sectionSchemas: Record<string, z.ZodType<Record<string, unknown>, unknown>>;
  /** Sections rendered when the merchant has not configured any. */
  defaultSections: Array<{ type: string; enabled: boolean }>;
  Layout: ComponentType<LayoutProps<TSettings>>;
  /** Full-page "Coming soon" shown on every path of a draft store (contract D2). */
  ComingSoon: ComponentType<{ store: ThemeStore; settings: TSettings }>;
  // Section props are validated by the matching schema before render.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sections: Record<string, ComponentType<SectionProps<any>>>;
}
