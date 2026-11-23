import type { Role } from '@storeplix/types';
import { cn } from '@storeplix/ui';
import { notAssignableReason } from './roles';
import type { PermissionHolder } from '../lib/permissions';

// Figma Invite modal 90:26879 role radio cards: 16/14 padding, radius 8; selected = 2px brand-600 border on brand-50;
// title Body/14 Semibold, detail Caption/12 text-secondary, right tag Body/14 Semibold.
const tagFor = (r: Role) => (r.key === 'admin' ? 'Full access' : r.key === 'staff' ? 'Most common' : null);

export function RoleOptions({
  name,
  options,
  value,
  onChange,
  me,
  legend = 'Role',
}: {
  name: string;
  options: { role: Role; allowed: boolean }[];
  value: string | null;
  onChange: (roleId: string) => void;
  me: PermissionHolder;
  legend?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-1.5 text-body font-medium text-text-primary">{legend}</legend>
      {options.map(({ role: r, allowed }) => {
        const selected = value === r.id;
        const reason = allowed ? null : notAssignableReason(me, r);
        const tag = tagFor(r);
        return (
          <label
            key={r.id}
            className={cn(
              'flex items-center gap-3 rounded-lg px-4 py-3.5',
              selected ? 'border-2 border-brand-600 bg-brand-50' : 'border border-border-default bg-surface-card',
              allowed ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name={name}
              value={r.id}
              checked={selected}
              disabled={!allowed}
              onChange={() => onChange(r.id)}
              className="size-5 shrink-0 accent-brand-600"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-body font-semibold text-text-primary">{r.name}</span>
              {(r.description || reason) && <span className="text-caption text-text-secondary">{reason ?? r.description}</span>}
            </span>
            {tag && <span className="shrink-0 text-body font-semibold text-text-primary max-sm:hidden">{tag}</span>}
          </label>
        );
      })}
    </fieldset>
  );
}
