import type { ThemeConfig, ThemeSection } from '@storeplix/types';
import { cn, gripProps, Menu, Modal, SortableList, type MenuEntry } from '@storeplix/ui';
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, GripVertical, Lock, Monitor, MoreHorizontal, Plus, Smartphone, Tablet, Trash2 } from 'lucide-react';
import { useState, type Dispatch } from 'react';
import { getThemeDefinition, sectionDef } from '../theme-package';
import { addBlockedReason, visibilityOf, type Device, type EditorAction } from './editorReducer';

// Figma V3 editor left panel 2045:48343 (Sections tab): locked chrome rows (Announcement bar, Header & menu,
// Footer) open global settings; home-page rows have a grip (drag or Space+↑/↓), eye toggle, "Phone off" pill and
// a ••• menu (2057:51109: Duplicate, Move up/down, Show on…, Delete). Rename / Save as my section / Copy to another
// page / Rewrite with AI are out of scope and not shown.

export type LockedRow = 'announcement' | 'header' | 'footer';
export type Selection = { kind: 'section'; id: string } | { kind: 'locked'; row: LockedRow };

export function sectionLabel(config: ThemeConfig, section: ThemeSection): string {
  const theme = getThemeDefinition(config.theme);
  const def = theme && sectionDef(theme, section.type);
  const title = (section.settings?.title as string | undefined) ?? (section.settings?.heading as string | undefined);
  if (section.type === 'featured-products' && title) return title;
  return def?.label ?? section.type;
}

const rowBase = 'flex min-h-[38px] w-full items-center gap-1.5 rounded-md py-[7px] pr-1 pl-2 text-left outline-none';

function LockedItem({ label, active, onSelect }: { label: string; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className={cn(rowBase, 'focus-visible:shadow-focus', active ? 'bg-brand-50 text-brand-700 shadow-[inset_0_0_0_1.5px_var(--color-brand-600)]' : 'hover:bg-surface-subtle')}>
      <Lock aria-hidden className="size-3.5 shrink-0 text-text-muted" />
      <span className={cn('min-w-0 flex-1 truncate text-[13px] leading-[18px]', active ? 'font-semibold' : 'font-medium text-text-primary')}>{label}</span>
      <span className="sr-only">(fixed position)</span>
    </button>
  );
}

export function SectionList({
  config,
  selection,
  onSelect,
  dispatch,
  readOnly,
}: {
  config: ThemeConfig;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  dispatch: Dispatch<EditorAction>;
  readOnly: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [showOn, setShowOn] = useState<string | null>(null);
  const theme = getThemeDefinition(config.theme);
  const isLocked = (row: LockedRow) => selection?.kind === 'locked' && selection.row === row;
  const count = config.sections.length;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] leading-4 font-semibold tracking-[0.88px] text-text-muted uppercase">Header · every page</p>
      <LockedItem label="Announcement bar" active={isLocked('announcement')} onSelect={() => onSelect({ kind: 'locked', row: 'announcement' })} />
      <LockedItem label="Header & menu" active={isLocked('header')} onSelect={() => onSelect({ kind: 'locked', row: 'header' })} />

      <p className="text-[11px] leading-4 font-semibold tracking-[0.88px] text-text-muted uppercase">Home page</p>
      <SortableList
        label="Home page sections"
        className="gap-3"
        items={config.sections}
        disabled={readOnly}
        onMove={(from, to) => dispatch({ type: 'move', from, to })}
        renderItem={(section, { handle, isDragging, index }) => {
          const active = selection?.kind === 'section' && selection.id === section.id;
          const vis = visibilityOf(section);
          const label = sectionLabel(config, section);
          const entries: MenuEntry[] = [
            { key: 'dup', label: 'Duplicate', icon: <Copy />, disabled: !!addBlockedReason(config, section.type), onSelect: () => dispatch({ type: 'duplicate', id: section.id }) },
            { key: 'up', label: 'Move up', icon: <ArrowUp />, shortcut: '⌥↑', disabled: index === 0, onSelect: () => dispatch({ type: 'moveBy', id: section.id, delta: -1 }) },
            { key: 'down', label: 'Move down', icon: <ArrowDown />, shortcut: '⌥↓', disabled: index === count - 1, onSelect: () => dispatch({ type: 'moveBy', id: section.id, delta: 1 }) },
            { kind: 'separator', key: 's1' },
            {
              key: 'show',
              label: 'Show on…',
              hint: (['desktop', 'tablet', 'phone'] as Device[]).filter((d) => vis[d]).map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ') || 'Hidden everywhere',
              icon: <Monitor />,
              onSelect: () => setShowOn(section.id),
            },
            { kind: 'separator', key: 's2' },
            { key: 'del', label: 'Delete section', icon: <Trash2 />, danger: true, onSelect: () => dispatch({ type: 'remove', id: section.id }) },
          ];
          return (
            <div
              data-section-id={section.id}
              className={cn(
                'group flex items-center gap-1.5 rounded-md py-[7px] pr-1 pl-1',
                active ? 'bg-brand-50 shadow-[inset_0_0_0_1.5px_var(--color-brand-600)]' : 'hover:bg-surface-subtle',
                isDragging && 'bg-surface-card shadow-elevation-1',
              )}
            >
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Reorder ${label}`}
                  {...gripProps(handle)}
                  onKeyDown={(e) => {
                    // Alt+↑/↓ moves without entering drag mode (Figma shortcut ⌥↑ / ⌥↓).
                    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                      e.preventDefault();
                      dispatch({ type: 'moveBy', id: section.id, delta: e.key === 'ArrowUp' ? -1 : 1 });
                      return;
                    }
                    handle.listeners?.onKeyDown?.(e);
                  }}
                  className="flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-text-muted outline-none focus-visible:shadow-focus active:cursor-grabbing"
                >
                  <GripVertical aria-hidden className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect({ kind: 'section', id: section.id })}
                className="min-w-0 flex-1 truncate rounded-sm text-left outline-none focus-visible:shadow-focus"
              >
                <span
                  className={cn(
                    'text-[13px] leading-[18px]',
                    active ? 'font-semibold text-brand-700' : section.enabled ? 'font-medium text-text-primary' : 'font-medium text-text-muted',
                  )}
                >
                  {label}
                </span>
              </button>
              {!vis.phone && <span className="shrink-0 rounded-full bg-surface-subtle px-2 py-0.5 text-[11px] leading-4 font-medium text-text-muted">Phone off</span>}
              <button
                type="button"
                aria-label={section.enabled ? `Hide ${label}` : `Show ${label}`}
                aria-pressed={!section.enabled}
                disabled={readOnly}
                onClick={() => dispatch({ type: 'toggle', id: section.id })}
                className="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-secondary outline-none hover:bg-surface-card focus-visible:shadow-focus disabled:opacity-60"
              >
                {section.enabled ? <Eye aria-hidden className="size-3.5" /> : <EyeOff aria-hidden className="size-3.5" />}
              </button>
              {!readOnly && (
                <Menu
                  label={`${label} actions`}
                  trigger={<MoreHorizontal aria-hidden className="size-4" />}
                  entries={entries}
                  header={
                    <div className="flex flex-col">
                      <span className="text-body font-semibold text-text-primary">{label}</span>
                      <span className="text-caption text-text-muted">
                        Home page · section {index + 1} of {count}
                      </span>
                    </div>
                  }
                />
              )}
            </div>
          );
        }}
      />
      {!readOnly && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={count >= (theme?.limits.maxSections ?? 30)}
          className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border-strong py-[9px] text-[13px] leading-[18px] font-semibold text-brand-600 outline-none hover:bg-brand-50 focus-visible:shadow-focus disabled:opacity-50"
        >
          <Plus aria-hidden className="size-3.5" /> Add section
        </button>
      )}

      <p className="text-[11px] leading-4 font-semibold tracking-[0.88px] text-text-muted uppercase">Footer · every page</p>
      <LockedItem label="Footer" active={isLocked('footer')} onSelect={() => onSelect({ kind: 'locked', row: 'footer' })} />

      {adding && theme && (
        <Modal open onClose={() => setAdding(false)} title="Add a section" description={`${count} of ${theme.limits.maxSections} sections used on this page.`} className="max-w-[560px]">
          <ul className="grid gap-2 sm:grid-cols-2">
            {theme.sections.map((def) => {
              const blocked = addBlockedReason(config, def.type);
              return (
                <li key={def.type}>
                  <button
                    type="button"
                    disabled={!!blocked}
                    title={blocked ?? undefined}
                    onClick={() => {
                      const index = selection?.kind === 'section' ? config.sections.findIndex((s) => s.id === selection.id) + 1 : undefined;
                      dispatch({ type: 'add', sectionType: def.type, index: index && index > 0 ? index : undefined });
                      setAdding(false);
                    }}
                    className="flex w-full flex-col gap-0.5 rounded-lg border border-border-default p-3 text-left outline-none hover:border-brand-500 hover:bg-brand-50 focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border-default disabled:hover:bg-transparent"
                  >
                    <span className="text-body font-semibold text-text-primary">{def.label}</span>
                    <span className="text-caption text-text-muted">{blocked ?? def.description}</span>
                    {def.samplesProducts && <span className="text-[11px] text-warning">Shows sample products until you add your own</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </Modal>
      )}

      {showOn && (
        <ShowOnDialog section={config.sections.find((s) => s.id === showOn)!} label={sectionLabel(config, config.sections.find((s) => s.id === showOn)!)} dispatch={dispatch} onClose={() => setShowOn(null)} />
      )}
    </div>
  );
}

/** "Show on" submenu (2057:51202) as a small dialog: per-device toggles. */
function ShowOnDialog({ section, label, dispatch, onClose }: { section: ThemeSection; label: string; dispatch: Dispatch<EditorAction>; onClose: () => void }) {
  const vis = visibilityOf(section);
  const rows: { device: Device; label: string; icon: React.ReactNode }[] = [
    { device: 'desktop', label: 'Desktop', icon: <Monitor aria-hidden className="size-4" /> },
    { device: 'tablet', label: 'Tablet', icon: <Tablet aria-hidden className="size-4" /> },
    { device: 'phone', label: 'Phone', icon: <Smartphone aria-hidden className="size-4" /> },
  ];
  return (
    <Modal open onClose={onClose} title={`Show ${label} on`} description="Hidden parts still load fast — they’re simply not shown on that screen size." className="max-w-[380px]">
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.device}>
            <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-surface-subtle">
              <span className="text-text-secondary">{r.icon}</span>
              <span className="flex-1 text-body text-text-primary">{r.label}</span>
              <input
                type="checkbox"
                className="size-4 accent-brand-600"
                checked={vis[r.device]}
                onChange={(e) => dispatch({ type: 'setVisibility', id: section.id, device: r.device, value: e.target.checked })}
              />
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
