import { z } from 'zod';
import type { BaseThemeSettings, ResolvedSection, ResolvedThemeConfig, ThemeDefinition } from './types';

const MAX_SECTIONS = 30;

const RawThemeConfig = z.object({
  theme: z.string().max(100).catch(''),
  version: z.string().max(40).catch(''),
  settings: z.unknown().optional(),
  sections: z.unknown().optional(),
});

const RawSection = z.object({
  type: z.string().max(100),
  enabled: z.boolean().catch(true),
  settings: z.unknown().optional(),
});

function major(version: string): number | null {
  const m = /^(\d+)\.\d+\.\d+/.exec(version);
  return m ? Number(m[1]) : null;
}

export function isCompatibleVersion(configVersion: string, themeVersion: string): boolean {
  const a = major(configVersion);
  return a !== null && a === major(themeVersion);
}

/**
 * Turn untrusted merchant theme JSON into a fully validated config for `theme`.
 * Never throws. Anything invalid is replaced by defaults:
 *  - non-object / different major version  -> all defaults
 *  - invalid settings fields                -> per-field defaults (schemas `.catch`)
 *  - sections not an array                  -> theme default sections
 *  - unknown section types / bad entries    -> dropped
 */
export function resolveThemeConfig<S extends BaseThemeSettings>(
  theme: ThemeDefinition<S>,
  raw: unknown,
): ResolvedThemeConfig<S> {
  let usedFallback = false;
  const parsed = RawThemeConfig.safeParse(raw);
  let input: z.infer<typeof RawThemeConfig> = { theme: theme.id, version: theme.version, settings: {}, sections: undefined };

  if (!parsed.success) {
    usedFallback = raw !== undefined && raw !== null;
  } else if (parsed.data.theme !== theme.id || !isCompatibleVersion(parsed.data.version, theme.version)) {
    usedFallback = true;
  } else {
    input = parsed.data;
  }

  const settings = theme.settingsSchema.parse(input.settings);

  let rawSections: unknown[];
  if (Array.isArray(input.sections)) {
    rawSections = input.sections.slice(0, MAX_SECTIONS);
    if (input.sections.length > MAX_SECTIONS) usedFallback = true;
  } else {
    if (input.sections !== undefined) usedFallback = true;
    rawSections = theme.defaultSections;
  }

  const sections: ResolvedSection[] = [];
  rawSections.forEach((entry, index) => {
    const s = RawSection.safeParse(entry);
    const schema = s.success ? theme.sectionSchemas[s.data.type] : undefined;
    if (!s.success || !schema || !theme.sections[s.data.type]) {
      usedFallback = true;
      return;
    }
    sections.push({
      key: `${s.data.type}-${index}`,
      type: s.data.type,
      enabled: s.data.enabled,
      settings: schema.parse(s.data.settings),
    });
  });

  return { theme: theme.id, version: theme.version, settings, sections, usedFallback };
}
