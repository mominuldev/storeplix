import { modernCommerce } from './modern-commerce';
import type { ThemeDefinition } from './types';

export type * from './types';

// Single entry point for theme metadata. Swap the import for `@storeplix/themes` when SF ships it (contract §4.1).
const definitions: Record<string, ThemeDefinition> = { [modernCommerce.code]: modernCommerce };

export function getThemeDefinition(code: string): ThemeDefinition | null {
  return definitions[code] ?? null;
}

export function sectionDef(theme: ThemeDefinition, type: string) {
  return theme.sections.find((s) => s.type === type) ?? null;
}
