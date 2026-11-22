import type { CourierProvider, EditItemsReason, OrderReturnStatus, ReturnReason, ReturnStatus } from '@storeplix/types';

// Returns & exchanges 39:9900 / 146:32329 copy.
export const returnReasonLabels: Record<ReturnReason, string> = {
  wrong_size: 'Wrong size',
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  changed_mind: 'Changed mind',
  refused_at_door: 'Refused at door',
  other: 'Other',
};

export const editReasonLabels: Record<EditItemsReason, string> = {
  customer_request: 'Customer asked for a change',
  out_of_stock: 'An item is out of stock',
  wrong_item: 'Wrong item was added',
  other: 'Other',
};

export const courierLabels: Record<CourierProvider | 'manual', string> = { steadfast: 'Steadfast', pathao: 'Pathao', redx: 'RedX', manual: 'Own delivery' };

export const orderReturnStatusLabels: Record<Exclude<OrderReturnStatus, 'none'>, string> = {
  requested: 'Return requested',
  partially_returned: 'Partly returned',
  returned: 'Returned by customer',
};

export type ReturnTab = 'open' | ReturnStatus;

/** Tabs from §10 plus Exchanged (a final state that would otherwise have no tab). */
export const returnTabs: { value: ReturnTab; label: string }[] = [
  { value: 'open', label: 'All open' },
  { value: 'requested', label: 'Requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'received', label: 'Received' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'exchanged', label: 'Exchanged' },
  { value: 'closed', label: 'Closed' },
  { value: 'rejected', label: 'Rejected' },
];
