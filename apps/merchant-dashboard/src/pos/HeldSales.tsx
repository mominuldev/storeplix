import { POS_HELD_NOTE_MAX, type PosHeldSale } from '@storeplix/types';
import { Button, cn, Drawer, formatBdt, Modal } from '@storeplix/ui';
import { Clock, Search } from 'lucide-react';
import { useState } from 'react';
import { ErrorBlock, LoadingRows } from '../catalog/states';
import { timeAgo } from '../commerce/format';
import { filterHeld, HELD_STOCK_NOTE, heldSub, heldTitle } from './pos';
import { usePosHeld } from './queries';

// PHASE-8-8D §11.6 Held sales 22:2409 (section 27:1027): drawer "Held sales" + "Park a sale and serve the next
// customer"; client search "Search by customer or note"; cards (customer or "Walk-in customer", "{phone} · n items",
// total, "Held {relative} · “{note}”", Resume / Delete); footer note with the P88D-16 copy (Q242: no stock reserved).
// "Hold sale" opens a composed note dialog (optional note ≤ 120).

export function HeldSalesDrawer({
  open,
  registerId,
  activeId,
  busyId,
  onClose,
  onResume,
  onDelete,
}: {
  open: boolean;
  registerId: string;
  activeId: string | null;
  busyId: string | null;
  onClose: () => void;
  onResume: (h: PosHeldSale) => void;
  onDelete: (h: PosHeldSale) => void;
}) {
  const held = usePosHeld(open ? registerId : undefined);
  const [query, setQuery] = useState('');
  const list = filterHeld(held.data ?? [], query);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Held sales"
      description="Park a sale and serve the next customer"
      width={440}
      className="max-sm:w-full"
      footer={
        <p className="rounded-lg bg-surface-canvas px-3.5 py-3 text-caption text-text-secondary" data-testid="pos-held-note">
          {HELD_STOCK_NOTE}
        </p>
      }
    >
      <div className="flex flex-col gap-3" data-testid="pos-held-drawer">
        <label className="flex h-10 items-center gap-2 rounded-lg border border-border-default bg-surface-card px-3 focus-within:border-brand-600">
          <Search aria-hidden className="size-4 text-text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by customer or note"
            aria-label="Search by customer or note"
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
          />
        </label>
        {held.isPending ? (
          <LoadingRows rows={3} label="Loading held sales" />
        ) : held.isError ? (
          <ErrorBlock error={held.error} title="We couldn’t load held sales" onRetry={() => held.refetch()} />
        ) : list.length === 0 ? (
          <p className="py-10 text-center text-body text-text-muted" data-testid="pos-held-empty">
            {query.trim() ? 'No held sales match.' : 'No held sales'}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {list.map((h) => (
              <li
                key={h.id}
                data-testid="pos-held-card"
                className={cn('flex flex-col gap-2.5 rounded-lg border bg-surface-card p-4', h.id === activeId ? 'border-2 border-brand-600 bg-brand-50' : 'border-border-default')}
              >
                <div className="flex items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-semibold text-text-primary">{heldTitle(h)}</span>
                    <span className="text-caption text-text-secondary">{heldSub(h)}</span>
                  </div>
                  <span className="text-body-lg font-semibold text-text-primary">{formatBdt(h.total_amount)}</span>
                </div>
                <p className="flex items-center gap-1.5 text-caption text-text-secondary">
                  <Clock aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">
                    Held {timeAgo(h.created_at)}
                    {h.note ? ` · “${h.note}”` : ''}
                  </span>
                </p>
                <div className="flex gap-2">
                  <Button size="sm" className="flex-1" disabled={busyId === h.id} onClick={() => onResume(h)}>
                    Resume
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busyId === h.id} onClick={() => onDelete(h)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}

/** "Hold sale" note dialog (composed). */
export function HoldDialog({ pending, error, onClose, onHold }: { pending: boolean; error: string | null; onClose: () => void; onHold: (note: string | null) => void }) {
  const [note, setNote] = useState('');
  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      title="Hold sale"
      description={HELD_STOCK_NOTE}
      size="sm"
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => onHold(note.trim() || null)} data-testid="pos-hold-confirm">
            {pending ? 'Holding…' : 'Hold sale'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) onHold(note.trim() || null);
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-body font-medium text-text-primary">Note (optional)</span>
          <input
            autoFocus
            value={note}
            maxLength={POS_HELD_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Trying another size"
            data-testid="pos-hold-note"
            className="h-10 rounded-md border border-border-default bg-surface-card px-3 text-body outline-none focus-visible:border-brand-600 focus-visible:shadow-focus"
          />
        </label>
        {error && (
          <p className="text-body text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
