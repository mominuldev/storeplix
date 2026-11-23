import type { ReportMeta } from '@storeplix/types';
import { Button, Input, SegmentedControl, Tabs } from '@storeplix/ui';
import { Clock } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { PageHeader } from '../layout/PageHeader';
import { relativeTime } from '../online-store/hooks';
import { DeliveryTab } from './DeliveryTab';
import type { ReportType } from './queries';
import { ProfitTab } from './ProfitTab';
import { localToday, presetLabels, presetRange, rangeError, rangeFromParams, rangeLabel, type RangePreset, type ReportRange } from './range';
import { SalesTab } from './SalesTab';

// Phase 7 §8.3 Reports (Figma section 60:11810): Sales overview 60:11866, Profit & loss 60:12264, Delivery & returns
// 60:12662. Page header 61:12588, Report tabs 61:12621 (Money & COD / Products are Phase 8, hidden), Filter bar 62:13057
// with Report/Toolbar 60:11813 (range presets per §8.3; Compare is always on via `previous`; Export is out of scope).

const titles: Record<ReportType, { title: string; subtitle: string; note: string }> = {
  sales: { title: 'Sales overview', subtitle: 'Shipped and delivered orders', note: 'Shipped + delivered orders · BDT' },
  profit: { title: 'Profit & loss', subtitle: 'What you keep after every cost', note: 'Delivered orders, from cost prices and courier charges' },
  delivery: { title: 'Delivery & returns', subtitle: 'How your couriers performed', note: 'Parcels booked with couriers' },
};

export function ReportsPage({ type }: { type: ReportType }) {
  const scope = useStoreScope();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const today = localToday(scope.store?.timezone);
  const range = rangeFromParams(params, today);
  const [meta, setMeta] = useState<ReportMeta | null>(null);

  if (type === 'profit' && scope.role === 'staff') return <Navigate to={{ pathname: '/reports/sales', search: location.search }} replace />;

  const tabs = [
    { value: 'sales' as const, label: 'Sales' },
    ...(scope.canViewCosts ? [{ value: 'profit' as const, label: 'Profit & loss' }] : []),
    { value: 'delivery' as const, label: 'Delivery & returns' },
  ];
  const setRange = (r: { from: string; to: string } | null) => setParams(r ? { from: r.from, to: r.to } : {}, { replace: false });
  const t = titles[type];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t.title}
        subtitle={[`${t.subtitle} · ${rangeLabel(range.from, range.to)}`, scope.store?.name, meta ? `updated ${relativeTime(meta.generated_at)}` : null].filter(Boolean).join(' · ')}
      />
      <Tabs aria-label="Reports" items={tabs} value={type} onChange={(v) => navigate({ pathname: `/reports/${v}`, search: location.search })} />
      <RangeToolbar range={range} today={today} note={t.note} onChange={setRange} />
      {type === 'sales' && <SalesTab range={range} onMeta={setMeta} />}
      {type === 'profit' && <ProfitTab range={range} onMeta={setMeta} />}
      {type === 'delivery' && <DeliveryTab range={range} onMeta={setMeta} />}
    </div>
  );
}

const PRESETS: Exclude<RangePreset, 'custom'>[] = ['this_month', 'last_month', 'last_30', 'last_90'];

export function RangeToolbar({ range, today, note, onChange }: { range: ReportRange; today: string; note: string; onChange: (r: { from: string; to: string } | null) => void }) {
  const [custom, setCustom] = useState(range.preset === 'custom');
  const [draft, setDraft] = useState({ from: range.from, to: range.to });
  const [error, setError] = useState<string | null>(null);
  const showCustom = custom || range.preset === 'custom';
  const value: RangePreset = showCustom ? 'custom' : range.preset;

  const pick = (p: RangePreset) => {
    setError(null);
    if (p === 'custom') {
      setDraft({ from: range.from, to: range.to });
      setCustom(true);
      return;
    }
    setCustom(false);
    onChange(p === 'this_month' ? null : presetRange(p, today));
  };
  const apply = () => {
    const err = rangeError(draft.from, draft.to, today);
    setError(err);
    if (!err) onChange({ from: draft.from, to: draft.to > today ? today : draft.to });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          size="sm"
          aria-label="Date range"
          value={value}
          onChange={pick}
          options={[...PRESETS, 'custom' as const].map((p) => ({ value: p, label: presetLabels[p] }))}
          className="max-w-full overflow-x-auto"
        />
        <span className="inline-flex items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 py-[9px] text-body font-medium text-text-primary">
          <Clock aria-hidden className="size-4 text-text-secondary" />
          {rangeLabel(range.from, range.to)}
        </span>
        <span className="min-w-0 flex-1 text-right text-caption text-text-muted max-lg:hidden">{note}</span>
      </div>
      {showCustom && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <label className="flex flex-col gap-1 text-caption font-medium text-text-secondary">
            From
            <Input type="date" value={draft.from} min="2020-01-01" max={today} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} aria-invalid={!!error} />
          </label>
          <label className="flex flex-col gap-1 text-caption font-medium text-text-secondary">
            To
            <Input type="date" value={draft.to} min="2020-01-01" max={today} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} aria-invalid={!!error} />
          </label>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {error && (
            <p role="alert" className="basis-full text-caption text-danger">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
