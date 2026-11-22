import type { OrderEvent } from '@storeplix/types';
import { describe, expect, it } from 'vitest';
import { eventToEntry } from '../orders/timeline';

describe('order timeline: items_edited (P5B-62)', () => {
  it('lists the line changes from meta.changes, as the API writes them', () => {
    const e: OrderEvent = {
      id: '01jedit0000000000000000000',
      type: 'items_edited',
      from_status: null,
      to_status: null,
      actor: { type: 'user', user: { id: '01juser0000000000000000000', name: 'Rina' } },
      body: 'Customer called',
      meta: {
        reason: 'customer_request',
        changes: [
          { product_name: 'Cotton Kurta', variant_title: 'M', from: 1, to: 2 },
          { product_name: 'Muslin Wrap', variant_title: null, from: 1, to: 0 },
        ],
        previous_total_amount: 132000,
        total_amount: 252000,
      },
      created_at: '2026-11-22T10:00:00Z',
    };
    const entry = eventToEntry(e);
    expect(entry.title).toBe('Rina changed the items');
    expect(entry.detail).toBe('Cotton Kurta 1 → 2 · Muslin Wrap 1 → 0 — Customer called');
  });
});
