import type { ThemeConfig, ThemeSection } from '@storeplix/types';

// Contract §6: "N changes" = sections added/removed/changed/moved + changed global-settings groups,
// comparing the local draft with `published_config`.

const GLOBAL_GROUPS: Record<string, string[]> = {
  colours: ['primaryColor', 'secondaryColor', 'textColor', 'backgroundColor', 'stylePreset'],
  fonts: ['fontFamily', 'headingFontFamily'],
  corners: ['cornerStyle'],
  buttons: ['buttonStyle'],
  logoOnDark: ['logoOnDarkMediaId'],
  announcement: ['announcement'],
  header: ['header'],
  footer: ['footer'],
};

/** Stable JSON (sorted keys) so key order never counts as a change. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

export interface ChangeSummary {
  total: number;
  added: number;
  removed: number;
  changed: number;
  moved: number;
  /** Changed global groups, e.g. `colours`, `fonts`. */
  groups: string[];
}

export function summarizeChanges(draft: ThemeConfig, published: ThemeConfig | null | undefined): ChangeSummary {
  if (!published) return { total: draft.sections.length, added: draft.sections.length, removed: 0, changed: 0, moved: 0, groups: [] };
  const pub = new Map<string, ThemeSection>(published.sections.map((s) => [s.id, s]));
  const cur = new Map<string, ThemeSection>(draft.sections.map((s) => [s.id, s]));
  const added = draft.sections.filter((s) => !pub.has(s.id)).length;
  const removed = published.sections.filter((s) => !cur.has(s.id)).length;
  const common = draft.sections.filter((s) => pub.has(s.id));
  const changed = common.filter((s) => stableStringify(s) !== stableStringify(pub.get(s.id))).length;
  const draftOrder = common.map((s) => s.id);
  const pubOrder = published.sections.filter((s) => cur.has(s.id)).map((s) => s.id);
  const moved = draftOrder.length - lcsLength(draftOrder, pubOrder);
  const a = draft.settings as Record<string, unknown>;
  const b = published.settings as Record<string, unknown>;
  const groups = Object.entries(GLOBAL_GROUPS)
    .filter(([, keys]) => keys.some((k) => stableStringify(a[k]) !== stableStringify(b[k])))
    .map(([g]) => g);
  return { total: added + removed + changed + moved + groups.length, added, removed, changed, moved, groups };
}

export const countChanges = (draft: ThemeConfig, published: ThemeConfig | null | undefined) => summarizeChanges(draft, published).total;
