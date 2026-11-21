import type { BaseThemeSettings, ResolvedBlock, ResolvedSection, ResolvedThemeConfig, ThemeDefinition } from './types';
import type { SectionDesign } from './design';
import { isPlainObject, markFallback, recordFallbacks } from './schema-helpers';

export const MAX_SECTIONS = 30;
const ID_RE = /^[a-z0-9]{8,16}$/;
const TYPE_RE = /^[a-z0-9-]{1,64}$/;

function major(version: string): number | null {
  const m = /^(\d+)\.\d+\.\d+$/.exec(version);
  return m ? Number(m[1]) : null;
}

export function isCompatibleVersion(configVersion: string, themeVersion: string): boolean {
  const a = major(configVersion);
  return a !== null && a === major(themeVersion);
}

/** Default blocks for a section type: those of the first section of that type in defaults.json. */
function defaultBlocks(theme: ThemeDefinition<BaseThemeSettings>, type: string): unknown[] {
  const s = theme.defaults.sections.find((d) => isPlainObject(d) && d.type === type) as { blocks?: unknown[] } | undefined;
  return Array.isArray(s?.blocks) ? s.blocks : [];
}

function resolveBlocks(theme: ThemeDefinition<BaseThemeSettings>, type: string, raw: unknown, ids: Set<string>, sectionIndex: number): ResolvedBlock[] {
  const def = theme.sections[type]!.blocks;
  if (!def) {
    // Schema: `blocks` is forbidden for types without blocks.
    if (raw !== undefined) markFallback();
    return [];
  }
  let list: unknown[];
  if (raw === undefined) {
    // Legacy (1.0) configs have no blocks: show the theme's default blocks.
    list = defaultBlocks(theme, type);
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    markFallback();
    list = [];
  }
  if (list.length > def.max) markFallback();

  const out: ResolvedBlock[] = [];
  list.slice(0, def.max).forEach((b, i) => {
    if (!isPlainObject(b) || b.type !== def.type) {
      markFallback();
      return;
    }
    const settings = def.schema.parse(b.settings);
    if (!settings) return; // the block schema already recorded the fallback
    out.push({ id: uniqueId(b.id, `${type}-${sectionIndex}-${i}`, ids), type: def.type, settings });
  });
  return out;
}

/** Valid ids are kept; a missing id becomes `fallback` silently, an invalid/duplicate one is flagged. */
function uniqueId(raw: unknown, fallback: string, ids: Set<string>): string {
  let id = fallback;
  if (typeof raw === 'string' && ID_RE.test(raw)) id = raw;
  else if (raw !== undefined) markFallback();
  if (ids.has(id)) {
    markFallback();
    let n = 2;
    while (ids.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  ids.add(id);
  return id;
}

/**
 * Turn untrusted merchant theme JSON into a fully validated config for `theme`. Never throws.
 * Anything invalid is replaced by defaults and `usedFallback` is set:
 *  - non-object / other theme / different major version -> all defaults
 *  - invalid settings fields                            -> per-field defaults
 *  - sections not an array                              -> theme default sections
 *  - unknown section types / bad entries / bad blocks   -> dropped
 * A schema-valid config (packages/themes fixtures) resolves with `usedFallback === false`.
 */
export function resolveThemeConfig<S extends BaseThemeSettings>(theme: ThemeDefinition<S>, raw: unknown): ResolvedThemeConfig<S> {
  const t = theme as unknown as ThemeDefinition<BaseThemeSettings>;
  let forcedFallback = false;
  let input: Record<string, unknown> = {};

  if (isPlainObject(raw) && raw.theme === theme.id && typeof raw.version === 'string' && isCompatibleVersion(raw.version, theme.version)) {
    input = raw;
  } else if (raw !== undefined && raw !== null) {
    forcedFallback = true;
  }

  const { value, fallback } = recordFallbacks(() => {
    const settings = theme.settingsSchema.parse(input.settings);

    let rawSections: unknown[];
    if (Array.isArray(input.sections)) {
      rawSections = input.sections;
      if (rawSections.length > MAX_SECTIONS) markFallback();
    } else {
      if (input.sections !== undefined) markFallback();
      rawSections = t.defaults.sections;
    }

    const ids = new Set<string>();
    const sections: ResolvedSection[] = [];
    rawSections.slice(0, MAX_SECTIONS).forEach((entry, index) => {
      if (!isPlainObject(entry) || typeof entry.type !== 'string' || !TYPE_RE.test(entry.type) || !t.sections[entry.type]) {
        markFallback();
        if (isPlainObject(entry) && typeof entry.type === 'string') {
          console.warn(`[theme] skipped unknown section type "${entry.type.slice(0, 64)}"`);
        }
        return;
      }
      const def = t.sections[entry.type]!;
      let enabled = true;
      if (typeof entry.enabled === 'boolean') enabled = entry.enabled;
      else if (entry.enabled !== undefined) markFallback();

      const id = uniqueId(entry.id, `${entry.type}-${index}`, ids);
      const settings = def.schema.parse(entry.settings) as Record<string, unknown> & { design: SectionDesign };
      sections.push({ id, type: entry.type, enabled, settings, blocks: resolveBlocks(t, entry.type, entry.blocks, ids, index) });
    });
    return { settings, sections };
  });

  return {
    theme: theme.id,
    version: theme.version,
    settings: value.settings,
    sections: value.sections,
    usedFallback: forcedFallback || fallback,
  };
}
