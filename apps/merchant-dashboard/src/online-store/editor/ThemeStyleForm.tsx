import type { ThemeConfig } from '@storeplix/types';
import { cn, contrastRatio, SegmentedControl } from '@storeplix/ui';
import type { Dispatch } from 'react';
import { getThemeDefinition } from '../theme-package';
import type { EditorAction } from './editorReducer';

// Editor left panel "Theme style" tab (2045:48347): the Brand style form in compact form (presets, colours,
// fonts, corners). Same draft as Brand style 2035:46054.

export function ThemeStyleForm({ config, dispatch, disabled }: { config: ThemeConfig; dispatch: Dispatch<EditorAction>; disabled: boolean }) {
  const theme = getThemeDefinition(config.theme);
  const s = config.settings;
  if (!theme) return null;
  const pairing = theme.pairings.find((p) => p.body === s.fontFamily && p.heading === s.headingFontFamily);
  const colours = [
    ['primaryColor', 'Primary'],
    ['textColor', 'Text'],
    ['secondaryColor', 'Accent'],
    ['backgroundColor', 'Background'],
  ] as const;
  const heading = 'text-[11px] leading-4 font-semibold tracking-[0.66px] text-text-muted uppercase';
  return (
    <div className="flex flex-col gap-4">
      <p className={heading}>Start from a style</p>
      <div className="grid grid-cols-2 gap-2">
        {theme.presets.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={s.stylePreset === p.id}
            disabled={disabled}
            onClick={() => dispatch({ type: 'applyPreset', preset: p, pairing: theme.pairings.find((x) => x.id === p.pairing) })}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-2 text-left text-caption outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
              s.stylePreset === p.id ? 'bg-brand-50 font-semibold text-brand-700 shadow-[inset_0_0_0_1.5px_var(--color-brand-600)]' : 'text-text-secondary shadow-[inset_0_0_0_1px_var(--color-border-default)]',
            )}
          >
            <span className="flex -space-x-1">
              <span className="size-3.5 rounded-full border border-surface-card" style={{ backgroundColor: p.primaryColor }} />
              <span className="size-3.5 rounded-full border border-surface-card" style={{ backgroundColor: p.secondaryColor }} />
            </span>
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
      <p className={heading}>Colours</p>
      <ul className="flex flex-col gap-2">
        {colours.map(([key, label]) => {
          const ratio = key === 'backgroundColor' ? null : contrastRatio(s[key], s.backgroundColor);
          return (
            <li key={key} className="flex items-center gap-2.5">
              <input
                type="color"
                aria-label={`${label} colour`}
                value={s[key]}
                disabled={disabled}
                onChange={(e) => dispatch({ type: 'setGlobal', key, value: e.target.value.toLowerCase() })}
                className="h-7 w-9 cursor-pointer rounded-sm border border-border-default disabled:cursor-not-allowed"
              />
              <span className="flex-1 text-[13px] text-text-primary">{label}</span>
              <span className="text-[11px] text-text-muted uppercase">{s[key]}</span>
              {ratio !== null && <span className={cn('text-[11px] font-medium', ratio >= 4.5 ? 'text-success' : 'text-warning')}>{ratio.toFixed(1)}:1</span>}
            </li>
          );
        })}
      </ul>
      <p className={heading}>Fonts</p>
      <div className="flex flex-col gap-1.5">
        {theme.pairings.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={pairing?.id === p.id}
            disabled={disabled}
            onClick={() => dispatch({ type: 'applyPairing', pairing: p })}
            className={cn(
              'flex flex-col rounded-md px-3 py-2 text-left outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
              pairing?.id === p.id ? 'bg-brand-50 shadow-[inset_0_0_0_1.5px_var(--color-brand-600)]' : 'shadow-[inset_0_0_0_1px_var(--color-border-default)]',
            )}
          >
            <span className="text-[13px] font-semibold text-text-primary">{p.name}</span>
            <span className="text-[11px] text-text-muted">{p.hint}</span>
          </button>
        ))}
      </div>
      <p className={heading}>Corners & buttons</p>
      <SegmentedControl
        size="sm"
        aria-label="Corners & buttons"
        disabled={disabled}
        value={s.cornerStyle}
        onChange={(v) => dispatch({ type: 'setGlobal', key: 'cornerStyle', value: v })}
        options={[
          { value: 'square', label: 'Square' },
          { value: 'rounded', label: 'Rounded' },
          { value: 'pill', label: 'Pill' },
        ]}
      />
    </div>
  );
}
