import type { RichTextDoc } from '@storeplix/types';
import { cn, SegmentedControl, Toggle } from '@storeplix/ui';
import { lazy, Suspense, useId, useState } from 'react';
import { ImageField, type PickedMedia } from '../components/MediaPicker';
import { isSafeThemeHref } from '../lib/safeHref';
import type { FieldDef } from '../theme-package';

// Schema-driven field widgets for the V3 right panel (Figma 2045:48465): 12px Medium secondary label with an
// optional n/max counter, 13px inputs with a strong border and radius 8.

const RichTextEditor = lazy(() => import('../richtext/RichTextEditor'));

export interface LinkTarget {
  label: string;
  href: string;
}

export interface FieldContext {
  disabled: boolean;
  /** Images referenced by the config (id → url) for thumbnails. */
  media: Record<string, { url: string }>;
  /** Link picker suggestions (Home, published pages). */
  linkTargets: LinkTarget[];
  /** Remembers a picked image's URL for thumbnails (the draft stores only its id). */
  onMediaPicked?: (media: PickedMedia) => void;
}

const inputCls =
  'w-full rounded-md border border-border-strong bg-surface-card px-3 py-[9px] text-[13px] leading-[19px] text-text-primary outline-none placeholder:text-text-muted focus:border-brand-600 focus:shadow-focus disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-text-secondary aria-invalid:border-danger';

export function FieldLabel({ htmlFor, label, count, max, required }: { htmlFor?: string; label: string; count?: number; max?: number; required?: boolean }) {
  return (
    <div className="flex items-center text-caption">
      <label htmlFor={htmlFor} className="min-w-0 flex-1 font-medium text-text-secondary">
        {label}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {max !== undefined && (
        <span className={cn('text-[11px]', (count ?? 0) > max ? 'text-danger' : 'text-text-muted')}>
          {count ?? 0}/{max}
        </span>
      )}
    </div>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-caption text-danger">
      {message}
    </p>
  ) : null;
}

export function SchemaField({
  field,
  value,
  onChange,
  error,
  ctx,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
  ctx: FieldContext;
}) {
  const id = useId();
  const errId = `${id}-err`;
  const common = { id, disabled: ctx.disabled, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? errId : undefined } as const;
  // Optional strings are omitted when empty (schema: absent ≠ empty), required ones stay as typed.
  const str = (v: string) => (v === '' && !field.required ? undefined : v);

  switch (field.widget) {
    case 'text':
    case 'textarea': {
      const v = typeof value === 'string' ? value : '';
      return (
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={id} label={field.label} count={v.length} max={field.maxLength} required={field.required} />
          {field.widget === 'text' ? (
            <input {...common} className={inputCls} value={v} onChange={(e) => onChange(str(e.target.value))} />
          ) : (
            <textarea {...common} rows={3} className={cn(inputCls, 'resize-y')} value={v} onChange={(e) => onChange(str(e.target.value))} />
          )}
          <FieldError id={errId} message={error} />
        </div>
      );
    }
    case 'link':
      return <LinkField id={id} field={field} value={typeof value === 'string' ? value : ''} onChange={onChange} error={error} ctx={ctx} />;
    case 'image': {
      const mediaId = typeof value === 'string' ? value : null;
      const picked: PickedMedia | null = mediaId ? { id: mediaId, url: ctx.media[mediaId]?.url ?? '' } : null;
      return (
        <div className="flex flex-col gap-1">
          <ImageField label={field.label} value={picked} disabled={ctx.disabled} onChange={(m) => {
              if (m) ctx.onMediaPicked?.(m);
              onChange(m ? m.id : null);
            }} hint="1920 × 1080 · landscape · JPG, PNG or WebP" />
          <FieldError id={errId} message={error} />
        </div>
      );
    }
    case 'select':
      return (
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={id} label={field.label} />
          <select {...common} className={inputCls} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <FieldError id={errId} message={error} />
        </div>
      );
    case 'segmented':
      return (
        <div className="flex flex-col gap-1.5">
          <FieldLabel label={field.label} />
          <SegmentedControl
            size="sm"
            aria-label={field.label}
            disabled={ctx.disabled}
            value={typeof value === 'string' ? value : (field.options?.[0]?.value ?? '')}
            onChange={onChange}
            options={field.options ?? []}
          />
          <FieldError id={errId} message={error} />
        </div>
      );
    case 'toggle':
      return (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-text-primary">{field.label}</span>
          <Toggle label={field.label} checked={value === true} disabled={ctx.disabled} onChange={onChange} />
        </div>
      );
    case 'slider':
    case 'number': {
      const n = typeof value === 'number' ? value : (field.min ?? 0);
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center text-caption">
            <label htmlFor={id} className="flex-1 font-medium text-text-secondary">
              {field.label}
            </label>
            <span className="text-[13px] text-text-primary">
              {n}
              {field.max && field.max > 10 ? ' px' : ''}
            </span>
          </div>
          <input
            {...common}
            type="range"
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            value={n}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full accent-brand-600"
          />
          <FieldError id={errId} message={error} />
        </div>
      );
    }
    case 'color': {
      const v = typeof value === 'string' ? value : '#ffffff';
      return (
        <div className="flex items-center gap-3">
          <input {...common} type="color" value={v} onChange={(e) => onChange(e.target.value.toLowerCase())} className="h-8 w-10 cursor-pointer rounded-sm border border-border-default disabled:cursor-not-allowed" />
          <label htmlFor={id} className="text-[13px] text-text-primary">
            {field.label}
          </label>
          <FieldError id={errId} message={error} />
        </div>
      );
    }
    case 'datetime': {
      const v = typeof value === 'string' ? toLocalInput(value) : '';
      return (
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={id} label={field.label} />
          <input {...common} type="datetime-local" className={inputCls} value={v} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} />
          {field.hint && <p className="text-[11px] text-text-muted">{field.hint}</p>}
          <FieldError id={errId} message={error} />
        </div>
      );
    }
    case 'richtext':
      return (
        <div className="flex flex-col gap-1.5">
          <FieldLabel label={field.label} />
          <Suspense fallback={<div className="h-28 animate-pulse rounded-md bg-surface-subtle" />}>
            <RichTextEditor label={field.label} value={(value as RichTextDoc) ?? null} onChange={onChange} disabled={ctx.disabled} />
          </Suspense>
          <FieldError id={errId} message={error} />
        </div>
      );
    default:
      return null;
  }
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Button goes to": page picker (Home, published pages) or a custom link, validated with SafeHref.theme(). */
function LinkField({ id, field, value, onChange, error, ctx }: { id: string; field: FieldDef; value: string; onChange: (v: unknown) => void; error?: string; ctx: FieldContext }) {
  const known = ctx.linkTargets.find((t) => t.href === value);
  const [custom, setCustom] = useState(!known && value !== '');
  const [draft, setDraft] = useState(value);
  const localError = draft && !isSafeThemeHref(draft) ? 'Use a link starting with / or https://' : undefined;
  const shown = error ?? (custom ? localError : undefined);
  const errId = `${id}-err`;
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id} label={field.label} required={field.required} />
      <select
        id={id}
        disabled={ctx.disabled}
        className={inputCls}
        value={custom ? '__custom' : (known?.href ?? '')}
        onChange={(e) => {
          if (e.target.value === '__custom') {
            setCustom(true);
            setDraft(value);
            return;
          }
          setCustom(false);
          onChange(e.target.value === '' && !field.required ? undefined : e.target.value);
        }}
      >
        {!field.required && <option value="">No link</option>}
        {field.required && !known && !custom && <option value="">Choose…</option>}
        {ctx.linkTargets.map((t) => (
          <option key={t.href} value={t.href}>
            {t.label}
          </option>
        ))}
        <option value="__custom">Web address or collection…</option>
      </select>
      {custom && (
        <input
          aria-label={`${field.label} link`}
          placeholder="/collections/winter or https://…"
          disabled={ctx.disabled}
          aria-invalid={shown ? true : undefined}
          aria-describedby={shown ? errId : undefined}
          className={inputCls}
          value={draft}
          onChange={(e) => {
            const v = e.target.value.trim();
            setDraft(v);
            // Only safe links reach the draft; unsafe input stays local with an inline error.
            if (v === '') onChange(field.required ? '' : undefined);
            else if (isSafeThemeHref(v)) onChange(v);
          }}
        />
      )}
      <FieldError id={errId} message={shown} />
    </div>
  );
}
