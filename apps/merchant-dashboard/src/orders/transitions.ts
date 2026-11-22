import { isApiError } from '@storeplix/api-client';
import type { Order, OrderStatus } from '@storeplix/types';
import { useMutation } from '@tanstack/react-query';
import { formatBdt } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';

// Order transitions and error handling shared by the Orders list 7:276, Order detail 33:3676 and the order dialogs.
export const CHANGED_MESSAGE = 'This order changed. We reloaded it.';

export type Target = { id: string; number: string; customerId?: string | null };

/** One-click transitions (confirm, ready, deliver). State comes from the response (§9.1); 409 → refetch + toast. */
export function useQuickTransition(onDone?: (order: Order) => void) {
  const { storeId } = useStoreScope();
  const invalidate = useCommerceInvalidate();
  return useMutation({
    mutationFn: ({ target, to }: { target: Target; to: Extract<OrderStatus, 'confirmed' | 'ready_to_ship' | 'delivered'> }) =>
      to === 'confirmed' ? api.orders.confirm(storeId!, target.id) : to === 'ready_to_ship' ? api.orders.ready(storeId!, target.id) : api.orders.deliver(storeId!, target.id),
    onSuccess: async (order, { target }) => {
      toast(`${order.number} · ${toastFor(order.status)}`);
      onDone?.(order);
      await invalidate.afterOrderChange(order.id, target.customerId);
    },
    onError: (e, { target }) => handleOrderError(e, () => invalidate.afterOrderChange(target.id, target.customerId)),
  });
}

function toastFor(status: OrderStatus): string {
  return status === 'confirmed' ? 'Confirmed.' : status === 'ready_to_ship' ? 'Marked packed.' : status === 'delivered' ? 'Delivered. Payment collected.' : 'Updated.';
}

export function handleOrderError(e: unknown, reload: () => unknown) {
  if (isApiError(e) && e.status === 409 && (e.code === 'invalid_state_transition' || e.code === 'revision_conflict')) {
    void reload();
    toast(CHANGED_MESSAGE, 'error');
    return;
  }
  toast(errorMessage(e, 'We couldn’t update this order.'), 'error');
}

/** Refund bounds: 1 paisa … refundable. */
export function refundAmountError(amount: number | null, refundable: number): string | null {
  if (amount === null) return 'Enter an amount.';
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter an amount like 500.';
  if (amount > refundable) return `You can refund up to ${formatBdt(refundable)}.`;
  return null;
}
