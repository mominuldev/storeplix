import type {
  InboxAssignee,
  InboxAttachment,
  InboxConversation,
  InboxConversationSummary,
  InboxListMeta,
  InboxMessage,
  InboxSavedReply,
  InboxSettings,
  InboxSummary,
} from '@storeplix/types';

// PHASE-8-8E fixtures (shapes from packages/types, openapi 1.25.0). Ids are ULID-like so they sort by time.

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
export const rafiq = { id: 'U1', name: 'Rahim Ahmed' };
export const sumon = { id: 'U2', name: 'Sumon Das' };

export function summary(o: Partial<InboxSummary> = {}): InboxSummary {
  return { unread: 3, open: 2, pending: 1, mine_open: 1, unassigned_open: 1, channels_enabled: { web_chat: true, order_messages: true, email: false }, ...o };
}

export function row(o: Partial<InboxConversationSummary> = {}): InboxConversationSummary {
  return {
    id: 'C1',
    channel: 'web_chat',
    status: 'open',
    identity: 'verified_phone',
    contact: { name: 'Farhana Yasmin', phone: '8801712345678', email: null },
    order: null,
    preview: 'Ei linen kurta ta XL e ache?',
    last_message_at: ago(1),
    assignee: rafiq,
    unread_count: 2,
    blocked: false,
    ...o,
  };
}

export function listMeta(o: Partial<InboxListMeta> = {}): InboxListMeta {
  return { next_cursor: null, prev_cursor: null, per_page: 30, counts: { open: 2, pending: 1, closed: 4 }, ...o };
}

export const rows = () => [
  row(),
  row({ id: 'C2', channel: 'order', contact: { name: 'Rubel Hossain', phone: '8801812345678', email: null }, order: { id: 'O2', number: 'GS-1042' }, preview: 'Delivery kobe pabo?', assignee: null, unread_count: 1 }),
];

export function conversation(o: Partial<InboxConversation> = {}): InboxConversation {
  return {
    ...row(),
    subject: null,
    context: { product_id: 'P1', name: 'Linen Kurta', price_amount: 185_000, currency: 'BDT', path: '/products/linen-kurta', image_url: null },
    source_path: '/products/linen-kurta',
    started_at: ago(30),
    first_response_seconds: 120,
    customer_seen_at: null,
    closed_at: null,
    closed_by: null,
    customer: {
      contact: { name: 'Farhana Yasmin', phone: '8801712345678', email: 'farhana@example.com' },
      customer: {
        id: 'CU1',
        name: 'Farhana Yasmin',
        since: '2026-03-02T00:00:00Z',
        orders_count: 4,
        phone: '8801712345678',
        email: 'farhana@example.com',
        address: { district: 'Dhaka', thana: 'Dhanmondi', street: 'Road 7A' },
        risk: { tier: 'good', rate: 1, delivered: 3, total: 3 },
      },
      linked_order: {
        id: 'O1',
        number: 'GS-1046',
        placed_at: ago(20),
        status: 'confirmed',
        payment_status: 'partially_paid',
        payment_method: 'cod',
        first_line: { name: 'Linen Kurta · Sage', variant: 'XL', quantity: 1, image_url: null },
        extra_lines: 0,
        paid_amount: 20_000,
        due_amount: 172_000,
        total_amount: 192_000,
        currency: 'BDT',
      },
      past_orders: [{ id: 'O3', number: 'GS-1031', placed_at: '2026-10-12T00:00:00Z', total_amount: 245_000, currency: 'BDT', status: 'delivered' }],
    },
    can: { reply: true, assign: true, link_order: true, delete: true, view_customer: true, view_order: true },
    revision: 3,
    ...o,
  };
}

export function attachment(o: Partial<InboxAttachment> = {}): InboxAttachment {
  return { id: 'A1', filename: 'bkash-receipt.pdf', mime: 'application/pdf', size_bytes: 214 * 1024, kind: 'pdf', status: 'ready', ...o };
}

export function message(o: Partial<InboxMessage> = {}): InboxMessage {
  return { id: '01JM0000000000000000000001', kind: 'customer', body: 'Assalamu alaikum. XL ache?', author: null, attachments: [], system: null, delivery_status: null, sms_status: null, seen: false, created_at: ago(10), ...o };
}

export const thread = (): InboxMessage[] => [
  message(),
  message({ id: '01JM0000000000000000000002', kind: 'system', body: null, system: { event: 'assigned', actor: rafiq, assignee: sumon, order_number: null }, created_at: ago(9) }),
  message({ id: '01JM0000000000000000000003', kind: 'reply', body: 'Ji apu, XL e 3 ta ache.', author: rafiq, sms_status: 'sent', created_at: ago(8) }),
  message({ id: '01JM0000000000000000000004', kind: 'customer', body: 'Receipt dilam.', attachments: [attachment()], created_at: ago(7) }),
  message({ id: '01JM0000000000000000000005', kind: 'note', body: 'TrxID 9KX72H1Q checked.', author: rafiq, created_at: ago(6) }),
];

export const assignees = (): InboxAssignee[] => [
  { user: rafiq, role_name: 'Owner', open_count: 6, is_you: true },
  { user: sumon, role_name: 'Staff', open_count: 2, is_you: false },
];

export function savedReply(o: Partial<InboxSavedReply> = {}): InboxSavedReply {
  return {
    id: 'R1',
    title: 'Delivery charge',
    shortcut: 'delivery',
    body: 'Dhaka r moddhe {delivery_inside}, baire {delivery_outside}.',
    show_as_chip: true,
    position: 1,
    attachment: null,
    use_count: 214,
    last_used_at: null,
    updated_by: rafiq,
    updated_at: ago(100),
    revision: 1,
    ...o,
  };
}

export const savedReplies = () => [
  savedReply(),
  savedReply({ id: 'R2', title: 'Send payment link', shortcut: 'pay', body: 'Advance din ei link e: {payment_link}', show_as_chip: false, position: 2, use_count: 41 }),
];

export function settings(o: Partial<InboxSettings> = {}): InboxSettings {
  return {
    channels: {
      web_chat: { enabled: true, live_on: 'mugdho.storeplix.com' },
      order_messages: { enabled: false },
      email: { enabled: true, address: 'shop-abc123@in.storeplix.com', available: true },
    },
    widget: { reply_time: 'minutes', hours: null, greeting: null },
    external_channels: [
      { channel: 'messenger', status: 'coming_later' },
      { channel: 'whatsapp', status: 'coming_later' },
      { channel: 'instagram', status: 'coming_later' },
    ],
    revision: 5,
    can: { edit: true },
    ...o,
  };
}
