import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { areaKey } from '../lib/areas';
import { cn } from '../lib/cn';

// Edit zone 66:17755 area picker (PHASE-5 §4): district list with expandable thanas and search. A whole-district
// checkbox covers every thana of that district. Areas already in another zone are disabled with that zone's name.

export interface AreaValue {
  district_code: string;
  /** null = the whole district */
  thana_code: string | null;
}

export interface AreaPickerDistrict {
  code: string;
  name: string;
  thanas: { code: string; name: string }[];
}

export interface AreaPickerProps {
  districts: AreaPickerDistrict[];
  value: AreaValue[];
  onChange: (value: AreaValue[]) => void;
  /** areaKey → name of the zone that already holds it */
  taken?: Record<string, string>;
  label?: string;
  className?: string;
}

export function AreaPicker({ districts, value, onChange, taken = {}, label = 'Areas', className }: AreaPickerProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const selected = useMemo(() => new Set(value.map(areaKey)), [value]);
  const needle = q.trim().toLowerCase();

  const visible = useMemo(() => {
    if (!needle) return districts.map((d) => ({ d, thanas: d.thanas, forceOpen: false }));
    return districts
      .map((d) => {
        const hit = d.name.toLowerCase().includes(needle);
        const thanas = hit ? d.thanas : d.thanas.filter((t) => t.name.toLowerCase().includes(needle));
        return { d, thanas, forceOpen: !hit && thanas.length > 0 };
      })
      .filter((x) => x.d.name.toLowerCase().includes(needle) || x.thanas.length > 0);
  }, [districts, needle]);

  const toggleDistrict = (d: AreaPickerDistrict, on: boolean) => {
    const rest = value.filter((a) => a.district_code !== d.code);
    onChange(on ? [...rest, { district_code: d.code, thana_code: null }] : rest);
  };
  const toggleThana = (d: AreaPickerDistrict, code: string, on: boolean) => {
    const rest = value.filter((a) => !(a.district_code === d.code && a.thana_code === code));
    onChange(on ? [...rest, { district_code: d.code, thana_code: code }] : rest);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <label className="flex h-[38px] items-center gap-2 rounded-md bg-surface-subtle px-3 focus-within:shadow-focus">
        <Search aria-hidden className="size-4 text-text-muted" />
        <input
          type="search"
          aria-label={`Search ${label.toLowerCase()}`}
          placeholder="Search district or thana"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
        />
      </label>
      <ul aria-label={label} className="max-h-80 overflow-y-auto rounded-md border border-border-default">
        {visible.map(({ d, thanas, forceOpen }) => {
          const whole = selected.has(d.code);
          const takenBy = taken[d.code];
          const expanded = forceOpen || !!open[d.code];
          const picked = thanas.filter((t) => selected.has(`${d.code}:${t.code}`)).length;
          const Chevron = expanded ? ChevronDown : ChevronRight;
          return (
            <li key={d.code} className="border-b border-border-default last:border-b-0">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  aria-label={`${expanded ? 'Hide' : 'Show'} thanas in ${d.name}`}
                  aria-expanded={expanded}
                  disabled={d.thanas.length === 0}
                  onClick={() => setOpen((o) => ({ ...o, [d.code]: !o[d.code] }))}
                  className="flex size-6 items-center justify-center rounded-sm text-text-muted hover:bg-surface-subtle disabled:opacity-30"
                >
                  <Chevron aria-hidden className="size-4" />
                </button>
                <label className={cn('flex min-w-0 flex-1 items-center gap-2 text-body', takenBy ? 'text-text-muted' : 'text-text-primary')}>
                  <input
                    type="checkbox"
                    className="size-4 accent-brand-600"
                    checked={whole}
                    disabled={!!takenBy}
                    onChange={(e) => toggleDistrict(d, e.target.checked)}
                  />
                  <span className="truncate font-medium">{d.name}</span>
                  <span className="truncate text-caption text-text-muted">
                    {takenBy ? `In ${takenBy}` : whole ? `Whole district · ${d.thanas.length} thanas` : picked ? `${picked} selected` : ''}
                  </span>
                </label>
              </div>
              {expanded && (
                <ul className="flex flex-col gap-0.5 pb-2 pl-14">
                  {thanas.map((t) => {
                    const k = `${d.code}:${t.code}`;
                    const tTaken = taken[k];
                    return (
                      <li key={t.code}>
                        <label className={cn('flex items-center gap-2 py-1 text-body', tTaken ? 'text-text-muted' : 'text-text-primary')}>
                          <input
                            type="checkbox"
                            className="size-4 accent-brand-600"
                            checked={whole || selected.has(k)}
                            disabled={whole || !!tTaken}
                            onChange={(e) => toggleThana(d, t.code, e.target.checked)}
                          />
                          <span className="truncate">{t.name}</span>
                          {tTaken && <span className="truncate text-caption">In {tTaken}</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
        {visible.length === 0 && <li className="px-3 py-6 text-center text-body text-text-muted">No district or thana matches “{q}”.</li>}
      </ul>
    </div>
  );
}
