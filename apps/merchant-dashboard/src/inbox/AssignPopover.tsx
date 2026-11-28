import type { UserRef } from '@storeplix/types';
import { cn, Spinner } from '@storeplix/ui';
import { Check, ChevronDown, Search, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ContactAvatar } from './components';
import { firstName } from './inbox';
import { useAssignees } from './queries';

// PHASE-8-8E P88E-4, Figma 2121:51432 (menu 2121:51932): search team, Unassigned ("Back to the shared queue"), staff
// with role + open count, check on current, note. Selecting assigns (system row, assignee emailed server-side).

export function AssignPopover({
  assignee,
  disabled,
  busy,
  onAssign,
}: {
  assignee: UserRef | null;
  disabled?: boolean;
  busy?: boolean;
  onAssign: (userId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const assignees = useAssignees(open);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (id: string | null) => {
    setOpen(false);
    setQ('');
    if (id !== (assignee?.id ?? null)) onAssign(id);
  };
  const needle = q.trim().toLowerCase();
  const people = (assignees.data ?? []).filter((a) => !needle || a.user.name.toLowerCase().includes(needle));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Assignee: ${assignee ? assignee.name : 'Unassigned'}`}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-border-default bg-surface-card py-[5px] pr-2.5 pl-1.5 text-body font-medium text-text-primary outline-none hover:bg-surface-subtle focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60"
      >
        {assignee ? (
          <ContactAvatar name={assignee.name} size={22} />
        ) : (
          <span className="flex size-[22px] items-center justify-center rounded-full bg-surface-subtle">
            <Users aria-hidden className="size-3.5 text-text-secondary" />
          </span>
        )}
        <span className="max-w-32 truncate">{assignee ? firstName(assignee.name) : 'Unassigned'}</span>
        {busy ? <Spinner className="size-3.5" /> : <ChevronDown aria-hidden className="size-4 text-text-secondary" />}
      </button>
      {open && (
        <div role="dialog" aria-label="Assign conversation" className="absolute top-full left-0 z-30 mt-1 flex w-[272px] flex-col gap-1 rounded-card border border-border-default bg-surface-card p-2 shadow-elevation-1">
          <label className="flex items-center gap-2 rounded-lg bg-surface-subtle px-2.5 py-2">
            <Search aria-hidden className="size-4 text-text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search team"
              aria-label="Search team"
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
            />
          </label>
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {!needle && (
              <Option selected={!assignee} onClick={() => pick(null)} title="Unassigned" sub="Back to the shared queue" icon={<Users aria-hidden className="size-4 text-text-secondary" />} />
            )}
            {assignees.isPending && (
              <li className="flex justify-center py-3">
                <Spinner className="size-4" />
              </li>
            )}
            {assignees.isError && <li className="px-2 py-2 text-caption text-danger">We couldn’t load your team.</li>}
            {people.map((a) => (
              <Option
                key={a.user.id}
                selected={assignee?.id === a.user.id}
                onClick={() => pick(a.user.id)}
                title={a.is_you ? `${a.user.name} (you)` : a.user.name}
                sub={`${a.role_name} · ${a.open_count} open`}
                icon={<ContactAvatar name={a.user.name} size={22} className="size-7" />}
              />
            ))}
            {assignees.isSuccess && people.length === 0 && needle && <li className="px-2 py-2 text-caption text-text-secondary">No teammate matches.</li>}
          </ul>
          <p className="border-t border-border-default px-2 pt-2 text-caption text-text-muted">Only staff with the Inbox permission are listed. The new assignee is notified.</p>
        </div>
      )}
    </div>
  );
}

function Option({ title, sub, icon, selected, onClick }: { title: string; sub: string; icon: React.ReactNode; selected: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none focus-visible:shadow-focus', selected ? 'bg-brand-50' : 'hover:bg-surface-subtle')}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-subtle">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-text-primary">{title}</span>
          <span className="truncate text-caption text-text-secondary">{sub}</span>
        </span>
        {selected && <Check aria-hidden className="size-4 text-brand-600" />}
      </button>
    </li>
  );
}
