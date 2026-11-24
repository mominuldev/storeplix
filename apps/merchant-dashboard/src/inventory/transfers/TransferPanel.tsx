import type { InventoryItem, Location, StockTransferDetail } from '@storeplix/types';
import { Badge, Button, cn, Dialog, Menu, Modal, Select } from '@storeplix/ui';
import { AlertTriangle, Check, MoreHorizontal, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatCount, plural } from '../../catalog/format';
import { useInventory } from '../../catalog/queries';
import { ErrorBlock, LoadingRows, NoResults } from '../../catalog/states';
import { Cell2, SearchBox, Thumb, useDebounced } from '../../catalog/ui';
import { clock, newIdempotencyKey } from '../../commerce/format';
import { ReadOnlyActions } from '../../impersonation/ReadOnlyActions';
import { toast } from '../../online-store/components/Toast';
import { stockAt } from '../locations';
import {
  dayLabel,
  draftLineFromItem,
  draftLinesOf,
  draftProblem,
  insufficientLines,
  lowStockWarning,
  receiveAllDraft,
  receiveInputOf,
  receiveTotals,
  sourceOf,
  stockPreview,
  transferError,
  transferInputOf,
  transferPill,
  useTransferMutations,
  type DraftLine,
  type ReceiveDraft,
} from './transfers';

// Side panel 153:35202 (create / edit / detail). Draft: From / To fields (153:35207), lines "{From} stock a → b" (red at
// or below the threshold), warning 153:35235, "+ Add product" (variant picker, composed), Save draft / Send. In transit:
// per-line received inputs, "Receive all", live short, Receive. Cancel transfer lives in the header menu. Hidden: Reject,
// Approve & send, "Requested by … needs approval" (→ "Created by {name} · {time}").

const parseQty = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const qtyInput =
  'h-9 w-16 rounded-md border border-border-default bg-surface-card px-2 text-right text-body text-text-primary outline-none focus-visible:border-brand-600 focus-visible:shadow-focus aria-invalid:border-danger';

export function TransferPanel({
  transfer,
  locations,
  initialFrom,
  canWrite,
  locked,
  onClose,
  onSaved,
  inSheet = false,
}: {
  /** null = new transfer */
  transfer: StockTransferDetail | null;
  /** active locations */
  locations: Location[];
  initialFrom?: string | null;
  /** `inventory.adjust` */
  canWrite: boolean;
  /** plan has no `multi_warehouse`: create/edit/send blocked, receive/cancel allowed (P88C-13) */
  locked: boolean;
  onClose: () => void;
  onSaved: (t: StockTransferDetail) => void;
  /** rendered in a sheet that already shows the title */
  inSheet?: boolean;
}) {
  const status = transfer?.status ?? 'draft';
  const editable = canWrite && !locked && status === 'draft';
  const defaultFrom = initialFrom && locations.some((l) => l.id === initialFrom) ? initialFrom : (locations.find((l) => l.is_default)?.id ?? locations[0]?.id ?? '');
  const [from, setFrom] = useState(transfer?.from_location.id ?? defaultFrom);
  const [to, setTo] = useState(transfer?.to_location.id ?? locations.find((l) => l.id !== defaultFrom)?.id ?? '');
  const [lines, setLines] = useState<DraftLine[]>(() => (transfer ? draftLinesOf(transfer) : []));
  const [dirty, setDirty] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [short, setShort] = useState<Record<string, number>>({});
  const [receiveDraft, setReceiveDraft] = useState<ReceiveDraft>({});
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | 'receive' | null>(null);
  const key = useRef(newIdempotencyKey());
  const m = useTransferMutations();
  const busy = m.create.isPending || m.update.isPending || m.send.isPending || m.receive.isPending || m.cancel.isPending || m.remove.isPending;

  const locName = (id: string) => locations.find((l) => l.id === id)?.name ?? (transfer && transfer.from_location.id === id ? transfer.from_location.name : transfer?.to_location.id === id ? transfer.to_location.name : '');
  const fromName = locName(from);
  const fromIsOnline = !!locations.find((l) => l.id === from)?.is_default;
  const previews = lines.map((l) => ({ line: l, p: status === 'draft' ? stockPreview(fromName, sourceOf(l, from), l.quantity) : null }));
  const warning = status === 'draft' ? lowStockWarning(previews.map(({ line, p }) => ({ name: line.name, after: p?.after ?? 0, low: !!p?.low })), fromName, fromIsOnline) : null;

  const change = (fn: () => void) => {
    fn();
    setDirty(true);
    setError(null);
    setShort({});
  };

  const fail = (e: unknown, fallback: string) => {
    const over = insufficientLines(e);
    if (over.length) setShort(Object.fromEntries(over.map((o) => [o.variant_id, o.available])));
    const msg = transferError(e, fallback);
    if (msg) setError(msg);
  };

  const save = (send: boolean) => {
    const problem = draftProblem({ from, to, lines });
    if (problem) return setError(problem);
    setError(null);
    const input = transferInputOf({ from, to, note: transfer?.note ?? '', lines });
    const done = (t: StockTransferDetail) => {
      key.current = newIdempotencyKey();
      setDirty(false);
      toast(send ? `${t.number} sent · ${plural(t.units_sent, 'unit')} left ${t.from_location.name}.` : `${t.number} saved as a draft.`);
      onSaved(t);
    };
    if (!transfer) {
      m.create.mutate({ input: { ...input, send }, key: send ? key.current : undefined }, { onSuccess: done, onError: (e) => fail(e, send ? 'We couldn’t send this transfer.' : 'We couldn’t save this transfer.') });
      return;
    }
    const doSend = (rev: number) =>
      m.send.mutate({ id: transfer.id, key: key.current, revision: rev }, { onSuccess: done, onError: (e) => fail(e, 'We couldn’t send this transfer.') });
    if (dirty) {
      m.update.mutate(
        { id: transfer.id, input: { ...input, revision: transfer.revision } },
        {
          onSuccess: (t) => {
            if (send) doSend(t.revision);
            else done(t);
          },
          onError: (e) => fail(e, 'We couldn’t save this transfer.'),
        },
      );
    } else if (send) doSend(transfer.revision);
  };

  const totals = transfer ? receiveTotals(transfer, receiveDraft) : null;
  const anyEntered = Object.values(receiveDraft).some((v) => v !== null && v !== undefined);
  const receive = () => {
    if (!transfer) return;
    setConfirm(null);
    m.receive.mutate(
      { id: transfer.id, key: key.current, input: receiveInputOf(transfer, receiveDraft) },
      {
        onSuccess: (t) => {
          key.current = newIdempotencyKey();
          toast(`${t.number} received${t.units_short > 0 ? ` · ${formatCount(t.units_short)} short` : ''}.`);
          onSaved(t);
        },
        onError: (e) => fail(e, 'We couldn’t receive this transfer.'),
      },
    );
  };

  const cancel = () => {
    if (!transfer) return;
    setConfirm(null);
    m.cancel.mutate(
      { id: transfer.id, revision: transfer.revision },
      {
        onSuccess: (t) => {
          toast(transfer.status === 'in_transit' ? `${t.number} cancelled · stock went back to ${t.from_location.name}.` : `${t.number} cancelled.`);
          onSaved(t);
        },
        onError: (e) => fail(e, 'We couldn’t cancel this transfer.'),
      },
    );
  };

  const remove = () => {
    if (!transfer) return;
    setConfirm(null);
    m.remove.mutate(transfer.id, {
      onSuccess: () => {
        toast(`${transfer.number} deleted.`);
        onClose();
      },
      onError: (e) => fail(e, 'We couldn’t delete this draft.'),
    });
  };

  const pill = transfer ? transferPill(transfer) : null;
  const created = transfer ? [transfer.created_by?.name ? `Created by ${transfer.created_by.name}` : 'Created', dayLabel(transfer.created_at) === 'Today' ? clock(transfer.created_at) : `${dayLabel(transfer.created_at)} ${clock(transfer.created_at)}`].join(' · ') : 'Stock leaves on send and arrives when received.';
  const canCancel = canWrite && transfer && (status === 'draft' || status === 'in_transit');

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {inSheet ? (
            pill && (
              <Badge size="sm" tone={pill.tone} dot className="self-start">
                {pill.label}
              </Badge>
            )
          ) : (
            <h2 className="flex flex-wrap items-center gap-2 text-body-lg font-medium text-text-primary">
              {transfer ? transfer.number : 'New transfer'}
              {pill && (
                <Badge size="sm" tone={pill.tone} dot>
                  {pill.label}
                </Badge>
              )}
            </h2>
          )}
          <p className="text-body text-text-secondary">{created}</p>
        </div>
        {canCancel && (
          <ReadOnlyActions>
            <Menu
              label="Transfer actions"
              trigger={<MoreHorizontal aria-hidden className="size-4" />}
              triggerClassName="size-9 rounded-md border border-border-default"
              entries={[
                { key: 'cancel', label: 'Cancel transfer', hint: status === 'in_transit' ? 'Sent units go back to the source' : 'No stock changes', icon: <X />, danger: true, onSelect: () => setConfirm('cancel') },
                ...(status === 'draft' ? [{ key: 'delete', label: 'Delete draft', icon: <Trash2 />, danger: true, onSelect: () => setConfirm('delete') }] : []),
              ]}
            />
          </ReadOnlyActions>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {editable ? (
          <>
            <Select label="From" value={from} onChange={(e) => change(() => setFrom(e.target.value))}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <Select label="To" value={to} onChange={(e) => change(() => setTo(e.target.value))}>
              <option value="">Choose…</option>
              {locations
                .filter((l) => l.id !== from)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </Select>
          </>
        ) : (
          <>
            <ReadField label="From" value={transfer?.from_location.name ?? fromName} />
            <ReadField label="To" value={transfer?.to_location.name ?? locName(to)} />
          </>
        )}
      </div>

      {lines.length === 0 && !editable ? null : lines.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-default px-3 py-4 text-center text-body text-text-muted">Add the products you’re moving.</p>
      ) : (
        <ul aria-label="Transfer items" className="flex flex-col gap-2.5">
          {previews.map(({ line: l, p }) => {
            const tl = transfer?.lines.find((x) => x.variant.id === l.variant_id);
            const name = `${l.name}${l.variant ? ` ${l.variant}` : ''}`;
            const shortAvail = short[l.variant_id];
            return (
              <li key={l.variant_id} className="flex items-center gap-2.5 rounded-lg border border-border-default px-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-body font-medium text-text-primary">{l.name}</span>
                  <span className={cn('text-caption', p?.low || shortAvail !== undefined ? 'text-danger' : 'text-text-secondary')}>
                    {[l.variant, p?.text].filter(Boolean).join(' · ') || '—'}
                  </span>
                  {shortAvail !== undefined && <span className="text-caption text-danger">Only {formatCount(shortAvail)} available at {fromName}</span>}
                  {status === 'received' && tl && tl.quantity_received !== null && tl.quantity_received < tl.quantity && (
                    <span className="text-caption text-danger">
                      {formatCount(tl.quantity_received)} received · {formatCount(tl.quantity - tl.quantity_received)} short
                    </span>
                  )}
                </div>
                {editable ? (
                  <>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      aria-label={`Quantity of ${name}`}
                      aria-invalid={!l.quantity || l.quantity < 1 || !!p?.over || undefined}
                      value={l.quantity ?? ''}
                      onChange={(e) => change(() => setLines((ls) => ls.map((x) => (x.variant_id === l.variant_id ? { ...x, quantity: parseQty(e.target.value) } : x))))}
                      className={qtyInput}
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      onClick={() => change(() => setLines((ls) => ls.filter((x) => x.variant_id !== l.variant_id)))}
                      className="rounded-md p-1.5 text-text-muted outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
                    >
                      <X aria-hidden className="size-4" />
                    </button>
                  </>
                ) : status === 'in_transit' && canWrite && tl ? (
                  <span className="flex items-center gap-1.5 text-body text-text-secondary">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={tl.quantity}
                      aria-label={`Received of ${name}`}
                      aria-invalid={(receiveDraft[tl.id] ?? 0) > tl.quantity || (receiveDraft[tl.id] ?? 0) < 0 || undefined}
                      value={receiveDraft[tl.id] ?? ''}
                      placeholder="0"
                      onChange={(e) => {
                        setError(null);
                        setReceiveDraft((d) => ({ ...d, [tl.id]: parseQty(e.target.value) }));
                      }}
                      className={qtyInput}
                    />
                    <span className="whitespace-nowrap">/ {formatCount(tl.quantity)}</span>
                  </span>
                ) : (
                  <span className="text-body font-semibold whitespace-nowrap text-text-primary">× {formatCount(l.quantity ?? 0)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editable && (
        <button type="button" onClick={() => setPicking(true)} className="self-start text-body font-medium text-brand-600 hover:text-brand-700">
          + Add product
        </button>
      )}

      {warning && (
        <div role="note" className="flex items-center gap-2 rounded-lg bg-warning-bg px-3 py-2.5">
          <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 text-caption text-text-primary">{warning}</p>
        </div>
      )}

      {status === 'in_transit' && canWrite && totals && (
        <div className="flex flex-wrap items-center gap-2">
          <p aria-live="polite" className={cn('min-w-0 flex-1 text-body', totals.short > 0 ? 'text-danger' : 'text-text-secondary')}>
            {formatCount(totals.received)} received · {formatCount(totals.short)} short
          </p>
          <Button size="sm" variant="secondary" onClick={() => transfer && setReceiveDraft(receiveAllDraft(transfer))}>
            Receive all
          </Button>
        </div>
      )}
      {status === 'received' && transfer && (
        <p className={cn('text-body', transfer.units_short > 0 ? 'text-danger' : 'text-text-secondary')}>
          {formatCount(transfer.units_received ?? 0)} of {plural(transfer.units_sent, 'unit')} received{transfer.units_short > 0 ? ` · ${formatCount(transfer.units_short)} short, written off` : ''}
        </p>
      )}
      {status === 'draft' && transfer && locked && <p className="text-caption text-text-muted">Sending transfers needs the Growth plan. You can still cancel or delete this draft.</p>}

      {error && (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      )}

      {editable && (
        <ReadOnlyActions className="flex gap-2.5">
          <Button variant="secondary" className="flex-1" disabled={busy || (!!transfer && !dirty)} onClick={() => save(false)}>
            Save draft
          </Button>
          <Button className="flex-1" loading={m.send.isPending || (m.create.isPending && !!m.create.variables?.input.send)} disabled={busy} onClick={() => save(true)}>
            Send
          </Button>
        </ReadOnlyActions>
      )}
      {status === 'in_transit' && canWrite && totals && (
        <ReadOnlyActions className="flex">
          <Button className="flex-1" loading={m.receive.isPending} disabled={busy || totals.invalid || !anyEntered} onClick={() => (totals.short > 0 ? setConfirm('receive') : receive())}>
            Receive
          </Button>
        </ReadOnlyActions>
      )}

      {picking && (
        <TransferVariantPicker
          fromId={from}
          fromName={fromName}
          exclude={lines.map((l) => l.variant_id)}
          onClose={() => setPicking(false)}
          onPick={(i) => {
            change(() => setLines((ls) => [...ls, draftLineFromItem(i)]));
            setPicking(false);
          }}
        />
      )}
      <Dialog
        open={confirm === 'receive'}
        title={`Receive with ${totals ? formatCount(totals.short) : 0} short?`}
        description="Short units are written off. They don’t go back to the source."
        confirmLabel="Receive"
        tone="danger"
        onConfirm={receive}
        onCancel={() => setConfirm(null)}
      />
      <Dialog
        open={confirm === 'cancel'}
        title={`Cancel ${transfer?.number ?? 'transfer'}?`}
        description={status === 'in_transit' ? `The ${plural(transfer?.units_sent ?? 0, 'unit')} sent go back to ${transfer?.from_location.name}.` : 'Nothing has left the source yet, so stock doesn’t change.'}
        confirmLabel="Cancel transfer"
        cancelLabel="Keep"
        tone="danger"
        onConfirm={cancel}
        onCancel={() => setConfirm(null)}
      />
      <Dialog
        open={confirm === 'delete'}
        title={`Delete ${transfer?.number ?? 'draft'}?`}
        description="The draft is removed. Stock doesn’t change."
        confirmLabel="Delete draft"
        cancelLabel="Keep"
        tone="danger"
        onConfirm={remove}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-body font-medium text-text-primary">{label}</span>
      <span className="flex h-11 items-center truncate rounded-[10px] border border-border-default bg-surface-subtle px-3.5 text-body text-text-primary">{value}</span>
    </div>
  );
}

/** "+ Add product" (composed): tracked variants with "n at {From}". */
function TransferVariantPicker({ fromId, fromName, exclude, onClose, onPick }: { fromId: string; fromName: string; exclude: string[]; onClose: () => void; onPick: (i: InventoryItem) => void }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const list = useInventory({ q: debounced || undefined, per_page: 20 });
  const rows = (list.data?.data ?? []).filter((i) => i.track_inventory);
  return (
    <Modal open onClose={onClose} size="md" title="Add product" description={`Pick a product to move from ${fromName}. Only products that track stock can be transferred.`}>
      <div className="flex flex-col gap-3">
        <SearchBox value={q} onChange={setQ} placeholder="Product, SKU or barcode" label="Search products" />
        {list.isPending ? (
          <LoadingRows rows={3} label="Loading products" />
        ) : list.isError ? (
          <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <NoResults title={debounced ? `Nothing matches “${debounced}”` : 'No products that track stock yet'} />
        ) : (
          <ul className="flex max-h-80 flex-col divide-y divide-border-default overflow-y-auto rounded-lg border border-border-default">
            {rows.map((i) => {
              const added = exclude.includes(i.variant_id);
              const variant = i.title !== 'Default' ? i.title : null;
              const at = stockAt(i, fromId);
              return (
                <li key={i.variant_id}>
                  <button
                    type="button"
                    disabled={added}
                    aria-label={`Add ${i.product.name}${variant ? ` ${variant}` : ''}`}
                    onClick={() => onPick(i)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-surface-subtle focus-visible:bg-surface-subtle disabled:cursor-default disabled:opacity-60"
                  >
                    <Thumb src={i.product.image?.url} size={36} />
                    <Cell2 top={i.product.name} bottom={[variant, i.sku ? `SKU ${i.sku}` : null].filter(Boolean).join(' · ') || undefined} />
                    <span className="ml-auto shrink-0 text-caption text-text-muted">
                      {added ? <Check aria-label="Added" className="size-4 text-success" /> : `${formatCount(at.available)} at ${fromName}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
