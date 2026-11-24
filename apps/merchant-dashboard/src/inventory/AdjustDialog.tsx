import { isApiError } from '@storeplix/api-client';
import type { InventoryItem, Location, ManualStockReason } from '@storeplix/types';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '@storeplix/types';
import { Dialog, Input, SegmentedControl, Select } from '@storeplix/ui';
import { useState } from 'react';
import { formatCount } from '../catalog/format';
import { useInvalidate } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { Thumb } from '../catalog/ui';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { stockAt } from './locations';

// Inventory 11:743 "Adjust" (contract §9.1): reason select, + / − / set to, note; sends `expected_on_hand` so a
// concurrent change returns 409 `stock_changed` instead of overwriting. Low-stock threshold is editable here.
// PHASE-8-8C §10.1: with > 1 active location (`locations` passed) a Location select picks the stock row; the numbers,
// `expected_on_hand`, `location_id` and the threshold apply to that row. Without it nothing changes (default location).

export const reasonLabels: Record<ManualStockReason, string> = {
  received: 'Received new stock',
  correction: 'Correction (recount)',
  damaged: 'Damaged',
  lost: 'Lost or stolen',
  returned: 'Returned by customer',
  other: 'Other',
};

type Mode = 'add' | 'remove' | 'set';

/** Mount with a `key` per item so every opening starts fresh. */
export function AdjustDialog({
  item,
  open,
  onClose,
  initialReason = 'correction',
  locations = null,
  initialLocationId = null,
}: {
  item: InventoryItem;
  open: boolean;
  onClose: () => void;
  initialReason?: ManualStockReason;
  /** Active locations when the store has more than one; null hides the select. */
  locations?: Location[] | null;
  initialLocationId?: string | null;
}) {
  const { storeId } = useStoreScope();
  const invalidate = useInvalidate();
  const [base, setBase] = useState<InventoryItem>(item);
  const [locationId, setLocationId] = useState<string | null>(() => (locations ? (locations.find((l) => l.id === initialLocationId) ?? locations.find((l) => l.is_default) ?? locations[0])?.id ?? null : null));
  const location = locations?.find((l) => l.id === locationId) ?? null;
  const onHand = location ? stockAt(base, location.id).on_hand : base.on_hand;
  const [reason, setReason] = useState<ManualStockReason>(initialReason);
  const [mode, setMode] = useState<Mode>(initialReason === 'received' || initialReason === 'returned' ? 'add' : initialReason === 'correction' ? 'set' : 'remove');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [threshold, setThreshold] = useState(item.low_stock_threshold === null ? '' : String(item.low_stock_threshold));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const n = /^\d{1,7}$/.test(qty.trim()) ? Number(qty.trim()) : null;
  const next = n === null ? null : mode === 'set' ? n : mode === 'add' ? onHand + n : onHand - n;
  const thresholdValue = threshold.trim() === '' ? null : /^\d{1,6}$/.test(threshold.trim()) ? Number(threshold.trim()) : Number.NaN;
  const thresholdChanged = !Number.isNaN(thresholdValue) && thresholdValue !== base.low_stock_threshold;
  const stockChanged = next !== null && next !== onHand;

  const validate = (): string | null => {
    if (qty.trim() && n === null) return 'Enter a whole number.';
    if (mode !== 'set' && n === 0) return 'Enter a quantity above 0.';
    if (next !== null && next < 0) return `Only ${formatCount(onHand)} in stock${location ? ` at ${location.name}` : ''}.`;
    if (stockChanged && reason === 'other' && !note.trim()) return 'Add a note for “Other”.';
    if (Number.isNaN(thresholdValue)) return 'Low-stock alert must be a whole number.';
    if (!stockChanged && !thresholdChanged) return 'Nothing to change yet.';
    return null;
  };

  const save = async () => {
    const problem = validate();
    setError(problem);
    if (problem || !storeId) return;
    setSaving(true);
    try {
      if (thresholdChanged) await api.inventory.setThreshold(storeId, base.variant_id, thresholdValue, location?.id);
      if (stockChanged) {
        await api.inventory.adjust(storeId, {
          reason,
          note: note.trim() || null,
          items: [
            {
              variant_id: base.variant_id,
              mode: mode === 'set' ? 'set' : 'delta',
              quantity: mode === 'set' ? n! : mode === 'add' ? n! : -n!,
              expected_on_hand: onHand,
              ...(location ? { location_id: location.id } : {}),
            },
          ],
        });
      }
      await invalidate.afterAdjustment();
      toast(stockChanged ? `Stock for ${base.product.name} is now ${formatCount(next!)}${location ? ` at ${location.name}` : ''}.` : 'Low-stock alert saved.');
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'stock_changed') {
        const msg = Object.values(e.details ?? {})[0]?.[0] ?? 'Stock changed since you opened this. Check and try again.';
        setNotice(msg);
        setError(null);
        const fresh = await api.inventory.list(storeId, { product_id: base.product.id, per_page: 100 }).catch(() => null);
        const row = fresh?.data.find((r) => r.variant_id === base.variant_id);
        if (row) setBase(row);
        await invalidate.afterAdjustment();
      } else if (isApiError(e) && e.code === 'insufficient_stock') {
        setError(Object.values(e.details ?? {})[0]?.[0] ?? e.message);
      } else setError(isApiError(e) && e.details ? (Object.values(e.details)[0]?.[0] ?? e.message) : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      size="md"
      title="Adjust stock"
      description="Every change is saved to the stock ledger with the reason."
      confirmLabel="Save"
      loading={saving}
      onCancel={onClose}
      onConfirm={() => void save()}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg bg-surface-subtle p-3">
          <Thumb src={base.product.image?.url} size={40} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-semibold text-text-primary">{base.product.name}</span>
            <span className="truncate text-caption text-text-muted">
              {[base.title !== 'Default' ? base.title : null, base.sku ? `SKU ${base.sku}` : null].filter(Boolean).join(' · ') || 'Single variant'}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-heading text-text-primary">{formatCount(onHand)}</span>
            <span className="text-caption text-text-muted">{location ? `on hand at ${location.name}` : 'on hand'}</span>
          </div>
        </div>
        {notice && (
          <p role="status" className="rounded-md bg-warning-bg px-3 py-2 text-body text-text-primary">
            {notice}
          </p>
        )}
        {locations && (
          <Select label="Location" value={locationId ?? ''} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value as ManualStockReason)}>
          {(Object.keys(reasonLabels) as ManualStockReason[]).map((r) => (
            <option key={r} value={r}>
              {reasonLabels[r]}
            </option>
          ))}
        </Select>
        <SegmentedControl<Mode>
          aria-label="Change"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'add', label: '+ Add' },
            { value: 'remove', label: '− Remove' },
            { value: 'set', label: 'Set to' },
          ]}
        />
        <Input
          label={mode === 'set' ? 'New on-hand count' : 'Quantity'}
          inputMode="numeric"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          hint={next !== null ? `On hand after: ${formatCount(next)}` : undefined}
        />
        <Input label={reason === 'other' ? 'Note' : 'Note (optional)'} maxLength={255} value={note} onChange={(e) => setNote(e.target.value)} />
        <Input
          label="Low-stock alert at"
          inputMode="numeric"
          placeholder={String(DEFAULT_LOW_STOCK_THRESHOLD)}
          hint={`Shown as “Low” at this many or fewer. Empty = ${DEFAULT_LOW_STOCK_THRESHOLD}.`}
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        />
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
