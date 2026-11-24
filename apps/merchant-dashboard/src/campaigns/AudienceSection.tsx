import { isApiError } from '@storeplix/api-client';
import type { AudiencePreview, CampaignAudience, CampaignSegment } from '@storeplix/types';
import { Badge, Checkbox, cn, Input, MoneyInput, Select } from '@storeplix/ui';
import { Users, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatCount } from '../catalog/format';
import { useGeo } from '../commerce/queries';
import { paramsOf, SEGMENTS, segmentBounds, segmentLabel, segmentOptionLabel, withParams, withSegment } from './campaigns';
import { StepCard } from './ui';

// Figma 70:20204 Audience: segment select ("Bought twice, inactive 60 days · 214 customers"), inline params for the
// selected segment, "Skip Risky customers (n)" + helper, "Skip anyone who ordered in the last 7 days (n)", disabled
// always-checked "Opted-out customers are never messaged (n)" (P85-10), brand-50 summary row with the risk breakdown.

const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

export function AudienceSection({
  audience,
  onChange,
  preview,
  previewPending,
  previewError,
  error,
  disabled,
}: {
  audience: CampaignAudience;
  onChange: (a: CampaignAudience) => void;
  preview: AudiencePreview | undefined;
  previewPending: boolean;
  /** The preview query's error (null when fine). */
  previewError: unknown;
  error?: string;
  disabled?: boolean;
}) {
  const p = paramsOf(audience);
  const recentDays = audience.exclude.ordered_within_days ?? 7;
  const n = (v: number | undefined) => (v === undefined ? '…' : formatCount(v));

  return (
    <StepCard step={2} title="Audience" description="Who gets this message">
      <Select
        label="Send to segment"
        value={audience.segment}
        disabled={disabled}
        onChange={(e) => onChange(withSegment(e.target.value as CampaignSegment, audience))}
        error={error}
      >
        {SEGMENTS.map((s) => (
          <option key={s} value={s}>
            {s === audience.segment ? `${segmentLabel(audience)}${preview ? ` · ${formatCount(preview.matched)} customers` : ''}` : segmentOptionLabel[s]}
          </option>
        ))}
      </Select>

      {audience.segment === 'repeat_inactive' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Bought at least (orders)" value={p.min_orders} bounds={segmentBounds.min_orders} disabled={disabled} onChange={(v) => onChange(withParams(audience, { min_orders: v }))} />
          <NumberField label="Inactive for (days)" value={p.inactive_days} bounds={segmentBounds.inactive_days} disabled={disabled} onChange={(v) => onChange(withParams(audience, { inactive_days: v }))} />
        </div>
      )}
      {audience.segment === 'vip' && (
        <MoneyInput label="Spent more than" value={p.min_spent_amount ?? null} disabled={disabled} onChange={(v) => onChange(withParams(audience, { min_spent_amount: v ?? 0 }))} />
      )}
      {audience.segment === 'new_customers' && (
        <NumberField label="First order in the last (days)" value={p.days} bounds={segmentBounds.days} disabled={disabled} onChange={(v) => onChange(withParams(audience, { days: v }))} />
      )}
      {audience.segment === 'district' && <DistrictPicker value={p.districts ?? []} disabled={disabled} onChange={(d) => onChange(withParams(audience, { districts: d }))} />}
      {audience.segment === 'tag' && <Input label="Customer tag" value={p.tag ?? ''} maxLength={40} disabled={disabled} placeholder="e.g. wholesale" onChange={(e) => onChange(withParams(audience, { tag: e.target.value }))} />}

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <Checkbox
            label={<span className="font-medium text-text-primary">Skip Risky customers ({n(preview?.excluded.risky)})</span>}
            checked={audience.exclude.risky}
            disabled={disabled}
            onChange={(e) => onChange({ ...audience, exclude: { ...audience.exclude, risky: e.target.checked } })}
          />
          <p className="pl-[26px] text-caption text-text-muted">They returned most COD parcels — a coupon won’t change that</p>
        </div>
        <Checkbox
          label={
            <span className="font-medium text-text-primary">
              Skip anyone who ordered in the last {recentDays} days ({n(preview?.excluded.recent_orders)})
            </span>
          }
          checked={audience.exclude.ordered_within_days !== null}
          disabled={disabled}
          onChange={(e) => onChange({ ...audience, exclude: { ...audience.exclude, ordered_within_days: e.target.checked ? recentDays : null } })}
        />
        <Checkbox label={<span className="font-medium text-text-primary">Opted-out customers are never messaged ({n(preview?.excluded.opted_out)})</span>} checked disabled readOnly />
      </div>

      <div aria-live="polite" className="flex items-center gap-3 rounded-lg bg-brand-50 px-3.5 py-3">
        <Users aria-hidden className="size-[18px] shrink-0 text-brand-600" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {previewError ? (
            <p className="text-body font-semibold text-text-primary">
              {isApiError(previewError) && previewError.status === 429
                ? 'Too many changes in a row. Wait a moment and the count will update.'
                : 'We couldn’t count this audience. Check the segment and try again.'}
            </p>
          ) : preview ? (
            <>
              <p className={cn('text-body font-semibold text-text-primary', previewPending && 'opacity-60')} data-testid="audience-total">
                {preview.recipients === 1 ? '1 customer will get this message' : `${formatCount(preview.recipients)} customers will get this message`}
              </p>
              <p className="text-caption text-text-secondary">
                Good {pct(preview.risk_breakdown.good)} · Be careful {pct(preview.risk_breakdown.careful)} · Risky {pct(preview.risk_breakdown.risky)}
              </p>
            </>
          ) : (
            <p className="text-body font-semibold text-text-secondary">{previewPending ? 'Counting customers…' : 'Finish the segment to count customers.'}</p>
          )}
        </div>
      </div>
    </StepCard>
  );
}

function NumberField({ label, value, bounds, onChange, disabled }: { label: string; value: number | undefined; bounds: readonly [number, number]; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <Input
      label={label}
      type="number"
      inputMode="numeric"
      min={bounds[0]}
      max={bounds[1]}
      value={value ?? ''}
      disabled={disabled}
      hint={`${bounds[0]}–${bounds[1]}`}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.round(v));
      }}
    />
  );
}

function DistrictPicker({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const geo = useGeo();
  const [pick, setPick] = useState('');
  const names = useMemo(() => (geo.data?.districts ?? []).map((d) => d.name).sort((a, b) => a.localeCompare(b)), [geo.data]);
  return (
    <div className="flex flex-col gap-2">
      <Select
        label="Add district"
        value={pick}
        disabled={disabled || value.length >= 10 || !geo.data}
        hint={value.length >= 10 ? 'Up to 10 districts.' : undefined}
        onChange={(e) => {
          const d = e.target.value;
          setPick('');
          if (d && !value.includes(d)) onChange([...value, d]);
        }}
      >
        <option value="">{geo.isPending ? 'Loading districts…' : 'Choose a district'}</option>
        {names
          .filter((d) => !value.includes(d))
          .map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
      </Select>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Chosen districts">
          {value.map((d) => (
            <li key={d}>
              <Badge tone="brand" className="pr-1">
                {d}
                <button type="button" aria-label={`Remove ${d}`} disabled={disabled} onClick={() => onChange(value.filter((x) => x !== d))} className="rounded-full p-0.5 hover:bg-brand-100">
                  <X aria-hidden className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
