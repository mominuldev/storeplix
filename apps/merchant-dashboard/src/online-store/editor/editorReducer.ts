import type { ThemeBlock, ThemeConfig, ThemeGlobalSettings, ThemeSection } from '@storeplix/types';
import { uniqueId } from '../lib/ids';
import { setAt } from '../lib/path';
import { getThemeDefinition, sectionDef, type FontPairing, type StylePreset, type ThemeDefinition } from '../theme-package';
import { defaultDesign } from '../theme-package/modern-commerce';

// Contract §6 "Editor state rules": every edit goes through this pure reducer, which enforces limits
// (30 sections, maxInstances, maxBlocks) and generates ids. Undo keeps up to 50 steps.

export type Device = 'desktop' | 'tablet' | 'phone';
export const HISTORY_LIMIT = 50;
export const MAX_SECTIONS_FALLBACK = 30;

export interface EditorState {
  config: ThemeConfig;
  past: ThemeConfig[];
  /** Coalesces consecutive edits of the same field into one undo step. */
  lastEditKey: string | null;
  selectedId: string | null;
  /** Last limit/validation notice for the UI (e.g. "Hero can only be added once."). */
  notice: string | null;
}

export type EditorAction =
  | { type: 'reset'; config: ThemeConfig }
  | { type: 'select'; id: string | null }
  | { type: 'setGlobal'; key: string; value: unknown }
  | { type: 'applyPreset'; preset: StylePreset; pairing?: FontPairing }
  | { type: 'applyPairing'; pairing: FontPairing }
  | { type: 'setSection'; id: string; key: string; value: unknown }
  | { type: 'toggle'; id: string }
  | { type: 'setVisibility'; id: string; device: Device; value: boolean }
  | { type: 'add'; sectionType: string; index?: number }
  | { type: 'duplicate'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'move'; from: number; to: number }
  | { type: 'moveBy'; id: string; delta: number }
  | { type: 'resetSection'; id: string }
  | { type: 'addBlock'; id: string }
  | { type: 'removeBlock'; id: string; blockId: string }
  | { type: 'moveBlock'; id: string; from: number; to: number }
  | { type: 'setBlock'; id: string; blockId: string; key: string; value: unknown }
  | { type: 'undo' }
  | { type: 'clearNotice' };

export function initEditor(config: ThemeConfig): EditorState {
  return { config, past: [], lastEditKey: null, selectedId: config.sections[0]?.id ?? null, notice: null };
}

function allIds(config: ThemeConfig): Set<string> {
  const ids = new Set<string>();
  for (const s of config.sections) {
    ids.add(s.id);
    for (const b of s.blocks ?? []) ids.add(b.id);
  }
  return ids;
}

function maxSections(theme: ThemeDefinition | null) {
  return theme?.limits.maxSections ?? MAX_SECTIONS_FALLBACK;
}

/** Why a section of `type` can't be added right now, or null when it can. */
export function addBlockedReason(config: ThemeConfig, type: string): string | null {
  const theme = getThemeDefinition(config.theme);
  if (config.sections.length >= maxSections(theme)) return `A page can have up to ${maxSections(theme)} sections.`;
  const def = theme ? sectionDef(theme, type) : null;
  if (!def) return 'This section type isn’t available in your theme.';
  const count = config.sections.filter((s) => s.type === type).length;
  if (count >= def.maxInstances) return def.maxInstances === 1 ? `${def.label} can only be added once.` : `${def.label} can be added up to ${def.maxInstances} times.`;
  return null;
}

export function blockLimit(config: ThemeConfig, section: ThemeSection): number {
  const theme = getThemeDefinition(config.theme);
  return (theme && sectionDef(theme, section.type)?.block?.max) ?? 0;
}

function newSection(themeCode: string, type: string, taken: Set<string>): ThemeSection | null {
  const theme = getThemeDefinition(themeCode);
  const def = theme && sectionDef(theme, type);
  if (!def) return null;
  const id = uniqueId(taken);
  taken.add(id);
  const blocks: ThemeBlock[] | undefined = def.block
    ? (def.defaults.blocks ?? []).slice(0, def.block.max).map((settings) => {
        const bid = uniqueId(taken);
        taken.add(bid);
        return { id: bid, type: def.block!.type, settings: structuredClone(settings) };
      })
    : undefined;
  return {
    id,
    type,
    enabled: true,
    settings: { ...structuredClone(def.defaults.settings), design: { ...structuredClone(defaultDesign), ...((def.defaults.settings.design as object | undefined) ?? {}) } },
    ...(blocks ? { blocks } : {}),
  };
}

function mapSection(config: ThemeConfig, id: string, fn: (s: ThemeSection) => ThemeSection): ThemeConfig {
  return { ...config, sections: config.sections.map((s) => (s.id === id ? fn(s) : s)) };
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

const COLOR_KEYS = new Set(['primaryColor', 'secondaryColor', 'textColor', 'backgroundColor']);

/** Applies a config change and records history. `editKey` coalesces typing into one undo step. */
function commit(state: EditorState, config: ThemeConfig, editKey: string | null = null, patch: Partial<EditorState> = {}): EditorState {
  if (config === state.config) return { ...state, ...patch };
  const coalesce = editKey !== null && editKey === state.lastEditKey;
  const past = coalesce ? state.past : [...state.past, state.config].slice(-HISTORY_LIMIT);
  return { ...state, config, past, lastEditKey: editKey, notice: null, ...patch };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { config } = state;
  switch (action.type) {
    case 'reset':
      return initEditor(action.config);
    case 'select':
      return { ...state, selectedId: action.id };
    case 'clearNotice':
      return { ...state, notice: null };
    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      const selectedId = prev.sections.some((s) => s.id === state.selectedId) ? state.selectedId : (prev.sections[0]?.id ?? null);
      return { ...state, config: prev, past: state.past.slice(0, -1), lastEditKey: null, selectedId, notice: null };
    }
    case 'setGlobal': {
      let settings = setAt(config.settings as Record<string, unknown>, action.key, action.value) as ThemeGlobalSettings;
      // Any later colour edit detaches the preset (§4.3 stylePreset).
      if (COLOR_KEYS.has(action.key)) settings = { ...settings, stylePreset: null };
      return commit(state, { ...config, settings }, `g:${action.key}`);
    }
    case 'applyPreset': {
      const { preset, pairing } = action;
      const settings: ThemeGlobalSettings = {
        ...config.settings,
        primaryColor: preset.primaryColor,
        secondaryColor: preset.secondaryColor,
        textColor: preset.textColor,
        backgroundColor: preset.backgroundColor,
        stylePreset: preset.id,
        ...(pairing ? { fontFamily: pairing.body, headingFontFamily: pairing.heading } : {}),
      };
      return commit(state, { ...config, settings });
    }
    case 'applyPairing':
      return commit(state, { ...config, settings: { ...config.settings, fontFamily: action.pairing.body, headingFontFamily: action.pairing.heading } });
    case 'setSection':
      return commit(
        state,
        mapSection(config, action.id, (s) => ({ ...s, settings: setAt(s.settings ?? {}, action.key, action.value) })),
        `s:${action.id}:${action.key}`,
      );
    case 'toggle':
      return commit(state, mapSection(config, action.id, (s) => ({ ...s, enabled: !s.enabled })));
    case 'setVisibility':
      return commit(
        state,
        mapSection(config, action.id, (s) => {
          const design = { ...defaultDesign, ...((s.settings?.design as object) ?? {}) } as typeof defaultDesign;
          return { ...s, settings: { ...s.settings, design: { ...design, visibility: { ...design.visibility, [action.device]: action.value } } } };
        }),
      );
    case 'add': {
      const blocked = addBlockedReason(config, action.sectionType);
      if (blocked) return { ...state, notice: blocked };
      const section = newSection(config.theme, action.sectionType, allIds(config));
      if (!section) return { ...state, notice: 'This section type isn’t available in your theme.' };
      const index = action.index ?? config.sections.length;
      const sections = [...config.sections.slice(0, index), section, ...config.sections.slice(index)];
      return commit(state, { ...config, sections }, null, { selectedId: section.id });
    }
    case 'duplicate': {
      const index = config.sections.findIndex((s) => s.id === action.id);
      const source = config.sections[index];
      if (!source) return state;
      const blocked = addBlockedReason(config, source.type);
      if (blocked) return { ...state, notice: blocked };
      const taken = allIds(config);
      const id = uniqueId(taken);
      taken.add(id);
      const copy: ThemeSection = {
        ...structuredClone(source),
        id,
        ...(source.blocks
          ? {
              blocks: source.blocks.map((b) => {
                const bid = uniqueId(taken);
                taken.add(bid);
                return { ...structuredClone(b), id: bid };
              }),
            }
          : {}),
      };
      const sections = [...config.sections.slice(0, index + 1), copy, ...config.sections.slice(index + 1)];
      return commit(state, { ...config, sections }, null, { selectedId: id });
    }
    case 'remove': {
      const index = config.sections.findIndex((s) => s.id === action.id);
      if (index < 0) return state;
      const sections = config.sections.filter((s) => s.id !== action.id);
      const selectedId = state.selectedId === action.id ? (sections[Math.min(index, sections.length - 1)]?.id ?? null) : state.selectedId;
      return commit(state, { ...config, sections }, null, { selectedId });
    }
    case 'move': {
      const sections = move(config.sections, action.from, action.to);
      return sections === config.sections ? state : commit(state, { ...config, sections });
    }
    case 'moveBy': {
      const from = config.sections.findIndex((s) => s.id === action.id);
      const sections = move(config.sections, from, from + action.delta);
      return sections === config.sections ? state : commit(state, { ...config, sections });
    }
    case 'resetSection': {
      const theme = getThemeDefinition(config.theme);
      return commit(
        state,
        mapSection(config, action.id, (s) => {
          const def = theme && sectionDef(theme, s.type);
          if (!def) return s;
          const fresh = newSection(config.theme, s.type, allIds(config))!;
          return { ...fresh, id: s.id, enabled: s.enabled };
        }),
      );
    }
    case 'addBlock': {
      const section = config.sections.find((s) => s.id === action.id);
      const theme = getThemeDefinition(config.theme);
      const def = section && theme ? sectionDef(theme, section.type)?.block : null;
      if (!section || !def) return state;
      if ((section.blocks?.length ?? 0) >= def.max) return { ...state, notice: `This section can have up to ${def.max} ${def.label.toLowerCase()}s.` };
      const block: ThemeBlock = { id: uniqueId(allIds(config)), type: def.type, settings: structuredClone(def.defaults) };
      return commit(state, mapSection(config, action.id, (s) => ({ ...s, blocks: [...(s.blocks ?? []), block] })));
    }
    case 'removeBlock':
      return commit(state, mapSection(config, action.id, (s) => ({ ...s, blocks: (s.blocks ?? []).filter((b) => b.id !== action.blockId) })));
    case 'moveBlock':
      return commit(state, mapSection(config, action.id, (s) => ({ ...s, blocks: move(s.blocks ?? [], action.from, action.to) })));
    case 'setBlock':
      return commit(
        state,
        mapSection(config, action.id, (s) => ({
          ...s,
          blocks: (s.blocks ?? []).map((b) => (b.id === action.blockId ? { ...b, settings: setAt(b.settings, action.key, action.value) } : b)),
        })),
        `b:${action.blockId}:${action.key}`,
      );
  }
}

/** Visibility of a section (defaults to all devices). */
export function visibilityOf(section: ThemeSection): Record<Device, boolean> {
  const v = (section.settings?.design as { visibility?: Record<Device, boolean> } | undefined)?.visibility;
  return { desktop: v?.desktop ?? true, tablet: v?.tablet ?? true, phone: v?.phone ?? true };
}
