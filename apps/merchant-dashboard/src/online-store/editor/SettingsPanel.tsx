import type { ThemeConfig, ThemeGlobalSettings, ThemeSection } from '@storeplix/types';
import { Button, cn, gripProps, SegmentedControl, SortableList, Toggle } from '@storeplix/ui';
import { ChevronDown, GripVertical, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState, type Dispatch } from 'react';
import { Link } from 'react-router';
import { getAt } from '../lib/path';
import { getThemeDefinition, sectionDef, type FieldDef } from '../theme-package';
import { visibilityOf, type Device, type EditorAction } from './editorReducer';
import { SchemaField, type FieldContext } from './fields';
import { sectionLabel, type LockedRow, type Selection } from './SectionList';

// Figma V3 right panel 2045:48465 (Content) / Design tab 2050:49617. Fields are generated from the theme
// manifest; errors come from client JSON Schema validation and server 422 `details` (dot paths).

type Errors = Record<string, string[]>;

function first(errors: Errors, path: string) {
  return errors[path]?.[0];
}

export function SettingsPanel({
  config,
  selection,
  dispatch,
  errors,
  ctx,
}: {
  config: ThemeConfig;
  selection: Selection | null;
  dispatch: Dispatch<EditorAction>;
  errors: Errors;
  ctx: FieldContext;
}) {
  if (!selection) return <p className="text-body text-text-secondary">Pick a section on the left or click one in the preview.</p>;
  if (selection.kind === 'locked') return <GlobalGroup row={selection.row} config={config} dispatch={dispatch} errors={errors} ctx={ctx} />;
  const index = config.sections.findIndex((s) => s.id === selection.id);
  const section = config.sections[index];
  if (!section) return null;
  return <SectionSettings key={section.id} config={config} section={section} index={index} dispatch={dispatch} errors={errors} ctx={ctx} />;
}

function SectionSettings({
  config,
  section,
  index,
  dispatch,
  errors,
  ctx,
}: {
  config: ThemeConfig;
  section: ThemeSection;
  index: number;
  dispatch: Dispatch<EditorAction>;
  errors: Errors;
  ctx: FieldContext;
}) {
  const [tab, setTab] = useState<'content' | 'design'>('content');
  const theme = getThemeDefinition(config.theme);
  const def = theme && sectionDef(theme, section.type);
  const base = `config.sections.${index}`;
  const vis = visibilityOf(section);
  const label = sectionLabel(config, section);

  if (!def || !theme) return <p className="text-body text-text-secondary">This section type isn’t supported by your theme.</p>;

  const set = (key: string) => (value: unknown) => dispatch({ type: 'setSection', id: section.id, key, value });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[11px] leading-4 font-semibold tracking-[0.66px] text-text-muted uppercase">Home page › Section</p>
          <h2 className="truncate text-heading text-text-primary">{label}</h2>
        </div>
        {!ctx.disabled && (
          <button type="button" onClick={() => dispatch({ type: 'resetSection', id: section.id })} className="flex shrink-0 items-center gap-1 pt-4 text-caption font-medium text-text-secondary hover:text-text-primary">
            <RotateCcw aria-hidden className="size-3.5" /> Reset to theme
          </button>
        )}
      </div>
      {def.samplesProducts && <p className="rounded-md bg-info-bg px-3 py-2 text-caption text-info">Shows sample products until you add your own.</p>}
      {!section.enabled && <p className="rounded-md bg-surface-subtle px-3 py-2 text-caption text-text-secondary">This section is hidden. Use the eye on the left to show it.</p>}
      <SegmentedControl
        size="sm"
        aria-label="Settings tab"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'content', label: 'Content' },
          { value: 'design', label: 'Design' },
        ]}
      />
      {tab === 'content' ? (
        <>
          {def.fields.length === 0 && !def.block && <p className="text-caption text-text-muted">This section has design settings only.</p>}
          {def.fields.map((f) => (
            <SchemaField key={f.key} field={f} value={getAt(section.settings, f.key)} onChange={set(f.key)} error={first(errors, `${base}.settings.${f.key}`)} ctx={ctx} />
          ))}
          {def.block && <BlocksEditor section={section} base={base} def={def.block} dispatch={dispatch} errors={errors} ctx={ctx} />}
          <ShowOn vis={vis} disabled={ctx.disabled} onChange={(device, value) => dispatch({ type: 'setVisibility', id: section.id, device, value })} />
        </>
      ) : (
        <>
          {theme.designFields
            .filter((f) => f.key !== 'customBackground' || getAt(section.settings, 'design.background') === 'custom')
            .map((f) =>
              f.key === 'background' && f.options ? (
                <BackgroundSwatches
                  key={f.key}
                  label={f.label}
                  options={f.options}
                  settings={config.settings}
                  disabled={ctx.disabled}
                  value={(getAt(section.settings, 'design.background') as string | undefined) ?? 'default'}
                  onChange={set('design.background')}
                />
              ) : (
              <SchemaField
                key={f.key}
                field={f}
                value={getAt(section.settings, `design.${f.key}`)}
                onChange={set(`design.${f.key}`)}
                error={first(errors, `${base}.settings.design.${f.key}`)}
                ctx={ctx}
              />
              ),
            )}
          <ShowOn vis={vis} disabled={ctx.disabled} onChange={(device, value) => dispatch({ type: 'setVisibility', id: section.id, device, value })} />
        </>
      )}
    </div>
  );
}

function ShowOn({ vis, onChange, disabled }: { vis: Record<Device, boolean>; onChange: (d: Device, v: boolean) => void; disabled: boolean }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="pb-1.5 text-caption font-medium text-text-secondary">Show on</legend>
      <div className="flex gap-0.5 rounded-control bg-surface-subtle p-[3px]">
        {(['desktop', 'tablet', 'phone'] as Device[]).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={vis[d]}
            disabled={disabled}
            onClick={() => onChange(d, !vis[d])}
            className={cn(
              'flex-1 rounded-md px-2 py-[5px] text-caption outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
              vis[d] ? 'bg-surface-card font-semibold text-text-primary shadow-elevation-1' : 'font-medium text-text-muted line-through',
            )}
          >
            {d.charAt(0).toUpperCase() + d.slice(1)} {vis[d] ? '✓' : ''}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function BlocksEditor({
  section,
  base,
  def,
  dispatch,
  errors,
  ctx,
}: {
  section: ThemeSection;
  base: string;
  def: NonNullable<NonNullable<ReturnType<typeof sectionDef>>['block']>;
  dispatch: Dispatch<EditorAction>;
  errors: Errors;
  ctx: FieldContext;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const blocks = section.blocks ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-caption font-medium text-text-secondary">
          {def.label}s · {blocks.length}/{def.max}
        </span>
        {!ctx.disabled && (
          <Button size="sm" variant="ghost" leftIcon={<Plus aria-hidden className="size-3.5" />} disabled={blocks.length >= def.max} onClick={() => dispatch({ type: 'addBlock', id: section.id })}>
            Add
          </Button>
        )}
      </div>
      <SortableList
        label={`${def.label}s`}
        items={blocks}
        disabled={ctx.disabled}
        onMove={(from, to) => dispatch({ type: 'moveBlock', id: section.id, from, to })}
        renderItem={(block, { handle, index }) => {
          const title = String(getAt(block.settings, def.titleKey) ?? def.label) || def.label;
          const expanded = open === block.id;
          const hasError = Object.keys(errors).some((k) => k.startsWith(`${base}.blocks.${index}.`));
          return (
            <div className={cn('rounded-md border bg-surface-card', hasError ? 'border-danger' : 'border-border-default')}>
              <div className="flex items-center gap-1 px-1.5 py-1.5">
                {!ctx.disabled && (
                  <button type="button" aria-label={`Reorder ${title}`} {...gripProps(handle)} className="flex size-6 cursor-grab touch-none items-center justify-center text-text-muted">
                    <GripVertical aria-hidden className="size-3.5" />
                  </button>
                )}
                <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : block.id)} className="flex min-w-0 flex-1 items-center gap-1 text-left text-[13px] font-medium text-text-primary">
                  <span className="truncate">{title}</span>
                  <ChevronDown aria-hidden className={cn('ml-auto size-4 shrink-0 text-text-muted transition-transform', expanded && 'rotate-180')} />
                </button>
                {!ctx.disabled && (
                  <button type="button" aria-label={`Remove ${title}`} onClick={() => dispatch({ type: 'removeBlock', id: section.id, blockId: block.id })} className="flex size-6 items-center justify-center rounded-sm text-text-muted hover:text-danger">
                    <Trash2 aria-hidden className="size-3.5" />
                  </button>
                )}
              </div>
              {expanded && (
                <div className="flex flex-col gap-3 border-t border-border-default p-3">
                  {def.fields.map((f) => (
                    <SchemaField
                      key={f.key}
                      field={f}
                      value={getAt(block.settings, f.key)}
                      onChange={(value) => dispatch({ type: 'setBlock', id: section.id, blockId: block.id, key: f.key, value })}
                      error={first(errors, `${base}.blocks.${index}.settings.${f.key}`)}
                      ctx={ctx}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}

// ---------- locked rows → global settings groups ----------
const groups: Record<LockedRow, { title: string; fields: FieldDef[] }> = {
  announcement: {
    title: 'Announcement bar',
    fields: [
      { key: 'announcement.enabled', label: 'Show the announcement bar', widget: 'toggle' },
      { key: 'announcement.text', label: 'Text', widget: 'text', maxLength: 120, required: true },
      { key: 'announcement.href', label: 'Links to', widget: 'link' },
    ],
  },
  header: {
    title: 'Header & menu',
    fields: [
      { key: 'header.promoLink.label', label: 'Promo link text', widget: 'text', maxLength: 30, required: true },
      { key: 'header.promoLink.href', label: 'Promo link goes to', widget: 'link', required: true },
    ],
  },
  footer: {
    title: 'Footer',
    fields: [
      { key: 'footer.tagline', label: 'Tagline', widget: 'textarea', maxLength: 240 },
      { key: 'footer.showPaymentMethods', label: 'Show payment badges', widget: 'toggle' },
    ],
  },
};

function GlobalGroup({ row, config, dispatch, errors, ctx }: { row: LockedRow; config: ThemeConfig; dispatch: Dispatch<EditorAction>; errors: Errors; ctx: FieldContext }) {
  const group = groups[row];
  const settings = config.settings as Record<string, unknown>;
  const promo = config.settings.header.promoLink;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-[11px] leading-4 font-semibold tracking-[0.66px] text-text-muted uppercase">Every page</p>
        <h2 className="text-heading text-text-primary">{group.title}</h2>
      </div>
      {row === 'header' && (
        <>
          <p className="text-caption text-text-secondary">
            Menu links come from{' '}
            <Link to="/online-store/navigation" className="font-medium text-brand-600 hover:underline">
              Navigation
            </Link>
            .
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-text-primary">Show a promo link</span>
            <Toggle
              label="Show a promo link"
              checked={!!promo}
              disabled={ctx.disabled}
              onChange={(on) => dispatch({ type: 'setGlobal', key: 'header.promoLink', value: on ? { label: 'Offers', href: '/collections/all' } : null })}
            />
          </div>
        </>
      )}
      {group.fields
        .filter(() => row !== 'header' || !!promo)
        .map((f) => (
          <SchemaField
            key={f.key}
            field={f}
            value={getAt(settings, f.key)}
            onChange={(value) => dispatch({ type: 'setGlobal', key: f.key, value: value === undefined && (f.key === 'announcement.href' || f.key === 'footer.tagline') ? null : value })}
            error={first(errors, `config.settings.${f.key}`)}
            ctx={ctx}
          />
        ))}
    </div>
  );
}

/** Figma 2050:49617 Colours › Background: 28 px swatches from the theme colours, "+" for a custom colour. */
function BackgroundSwatches({
  label,
  options,
  settings,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { value: string; label: string }[];
  settings: ThemeGlobalSettings;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const fill: Record<string, string | undefined> = {
    default: settings.backgroundColor,
    muted: `color-mix(in srgb, ${settings.primaryColor} 8%, ${settings.backgroundColor})`,
    brand: settings.primaryColor,
    accent: settings.secondaryColor,
    inverse: settings.textColor,
  };
  const current = options.find((o) => o.value === value);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-2 text-caption font-medium text-text-secondary">{label}</legend>
      <div className="flex flex-wrap items-center gap-2.5">
        {options.map((o) => {
          const active = o.value === value;
          const custom = o.value === 'custom';
          return (
            <button
              key={o.value}
              type="button"
              aria-label={o.label}
              aria-pressed={active}
              title={o.label}
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className={cn(
                'flex size-7 items-center justify-center rounded-full outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
                active ? 'shadow-[0_0_0_2px_var(--color-surface-card),0_0_0_4px_var(--color-brand-600)]' : '',
                custom ? 'border border-dashed border-border-strong text-text-muted' : 'border border-border-default',
              )}
              style={custom ? undefined : { background: fill[o.value] }}
            >
              {custom && <Plus aria-hidden className="size-3.5" />}
            </button>
          );
        })}
      </div>
      <p className="text-caption text-text-muted">{current ? (current.value === 'custom' ? 'Your own colour' : `${current.label} · from your theme`) : ''}</p>
    </fieldset>
  );
}
