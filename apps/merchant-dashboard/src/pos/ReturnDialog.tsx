import { zodResolver } from '@hookform/resolvers/zod';
import { POS_PAYMENT_METHOD_LABELS, type PosPaymentMethod, type PosSale } from '@storeplix/types';
import { Button, cn, formatBdt, formatCount, Modal } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { newIdempotencyKey } from '../commerce/format';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { createAttemptKeys, returnableOf, returnEstimate, returnLines } from './pos';
import { posKeys } from './queries';

// PHASE-8-8D §11.7 / P88D-17 "Return items" (composed; Figma "Return or exchange items" relabelled, Q250): per-line
// quantity ≤ returnable (sold − returned), refund method (cash from this register's drawer, bKash or card), optional
// reason and note. One call creates, receives (full restock at the shop) and refunds. An exchange is a return plus a
// new sale. Needs `pos.sell` + `orders.refund` (the caller hides the action otherwise).

const methods: PosPaymentMethod[] = ['cash', 'bkash_personal', 'card'];

/**
 * Return reasons the API accepts (enum, default `other`). Typed locally until `packages/types` gains it (the API
 * shipped an enum where openapi 1.21.0 has free text).
 */
export type PosReturnReason = 'wrong_size' | 'damaged' | 'wrong_item' | 'changed_mind' | 'refused_at_door' | 'other';
const reasonOptions: { value: PosReturnReason; label: string }[] = [
  { value: 'wrong_size', label: 'Wrong size' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'changed_mind', label: 'Changed mind' },
  { value: 'refused_at_door', label: 'Refused at door' },
  { value: 'other', label: 'Other' },
];

const schema = z.object({
  reason: z.enum(['wrong_size', 'damaged', 'wrong_item', 'changed_mind', 'refused_at_door', 'other']),
  note: z.string().trim().max(300, 'Up to 300 characters'),
});
type Values = z.infer<typeof schema>;

/** Default refund method: the sale's own method when it was paid one way, else cash. */
function defaultMethod(sale: PosSale): PosPaymentMethod {
  return sale.paid_by === 'split' ? 'cash' : sale.paid_by;
}

export function ReturnDialog({ sale, sessionId, onClose }: { sale: PosSale; sessionId: string; onClose: () => void }) {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const items = sale.order.items.filter((i) => returnableOf(i) > 0);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<PosPaymentMethod>(defaultMethod(sale));
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createAttemptKeys(newIdempotencyKey));
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { reason: 'other', note: '' } });
  const lines = returnLines(items, picked);
  const estimate = returnEstimate(items, picked);

  const submit = useMutation({
    mutationFn: (values: Values) => {
      const input = { session_id: sessionId, lines: lines ?? [], refund_method: method, reason: values.reason, note: values.note || null };
      return api.pos.sales.returns(scope.storeId!, sale.id, input, keys.current.keyFor(JSON.stringify(input)));
    },
    onSuccess: (result) => {
      keys.current.reset();
      qc.setQueryData(posKeys.sale(scope, sale.id), result.sale);
      void qc.invalidateQueries({ queryKey: posKeys.sales(scope) });
      void qc.invalidateQueries({ queryKey: posKeys.session(scope, sessionId) });
      void qc.invalidateQueries({ queryKey: [scope.tenantId, scope.storeId, 'pos', 'catalog'] });
      toast(`Returned. Refund ${formatBdt(result.refund.amount)} by ${POS_PAYMENT_METHOD_LABELS[method]}.`);
      onClose();
    },
    onError: (e) => {
      if (handlePlanLimit(e)) return onClose();
      const code = e && typeof e === 'object' && 'code' in e ? e.code : '';
      if (code === 'drawer_short') return setError('There isn’t enough cash in the drawer for this refund. Refund by bKash or card, or return fewer items.');
      if (code === 'register_closed') return setError('This register was closed. Open it again to take returns.');
      if (code === 'return_not_allowed') return setError('Some of these items were already returned. Close this and check the receipt again.');
      if (code === 'refund_exceeds_paid') return setError('The refund is more than what’s left to refund on this sale.');
      setError(errorMessage(e, 'We couldn’t take this return.'));
    },
  });

  const setQty = (id: string, q: number, max: number) => setPicked({ ...picked, [id]: Math.max(0, Math.min(max, q)) });

  return (
    <Modal
      open
      onClose={() => !submit.isPending && onClose()}
      title="Return items"
      description={`Receipt ${sale.number} · stock goes back to this shop`}
      size="lg"
      className="max-md:h-dvh max-md:max-h-dvh max-md:w-full max-md:max-w-none max-md:rounded-none"
      footer={
        <>
          <Button variant="secondary" disabled={submit.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!lines || submit.isPending} onClick={() => void handleSubmit((v) => submit.mutate(v))()} data-testid="pos-return-submit">
            {submit.isPending ? 'Returning…' : lines ? `Return and refund ${formatBdt(estimate)}` : 'Pick items to return'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="pos-return-dialog">
        <ul className="flex flex-col">
          {items.map((i) => {
            const max = returnableOf(i);
            const q = picked[i.id] ?? 0;
            return (
              <li key={i.id} className="flex items-center gap-3 border-b border-border-default py-2.5 last:border-0" data-testid="pos-return-line">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body font-semibold text-text-primary">{i.product_name}</span>
                  <span className="text-caption text-text-secondary">
                    {[i.variant_title, `${formatCount(max)} of ${formatCount(i.quantity)} returnable`].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <div className="flex items-center rounded-md border border-border-default">
                  <button
                    type="button"
                    aria-label={`Return one less ${i.product_name}`}
                    className="flex size-9 items-center justify-center disabled:opacity-40"
                    disabled={q <= 0}
                    onClick={() => setQty(i.id, q - 1, max)}
                  >
                    <Minus aria-hidden className="size-3.5" />
                  </button>
                  <span className="w-8 text-center text-body font-semibold" data-testid="pos-return-qty">
                    {q}
                  </span>
                  <button
                    type="button"
                    aria-label={`Return one more ${i.product_name}`}
                    className="flex size-9 items-center justify-center disabled:opacity-40"
                    disabled={q >= max}
                    onClick={() => setQty(i.id, q + 1, max)}
                  >
                    <Plus aria-hidden className="size-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body font-medium text-text-primary">Refund by</legend>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Refund method">
            {methods.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                onClick={() => setMethod(m)}
                className={cn(
                  'rounded-[10px] py-2.5 text-body font-semibold',
                  method === m ? 'border-2 border-brand-600 bg-brand-50 text-brand-700' : 'border border-border-default bg-surface-card text-text-primary hover:bg-surface-subtle',
                )}
              >
                {POS_PAYMENT_METHOD_LABELS[m]}
              </button>
            ))}
          </div>
          <span className="text-caption text-text-muted">
            {method === 'cash' ? 'Cash comes out of this register’s drawer.' : `Send the money back by ${POS_PAYMENT_METHOD_LABELS[method]} yourself; this records it.`}
          </span>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-body font-medium text-text-primary">Reason</span>
            <select
              {...register('reason')}
              data-testid="pos-return-reason"
              className="h-10 rounded-md border border-border-default bg-surface-card px-3 text-body outline-none focus-visible:border-brand-600"
            >
              {reasonOptions.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            {formState.errors.reason && <span className="text-caption text-danger">{formState.errors.reason.message}</span>}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-body font-medium text-text-primary">Note (optional)</span>
            <input
              {...register('note')}
              maxLength={300}
              className="h-10 rounded-md border border-border-default bg-surface-card px-3 text-body outline-none focus-visible:border-brand-600"
            />
          </label>
        </div>
        <p className="text-caption text-text-muted">To exchange, return the items here, then ring up the new ones as a new sale.</p>
        {error && (
          <p className="rounded-lg bg-danger-bg px-4 py-3 text-body text-danger" role="alert" data-testid="pos-return-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
