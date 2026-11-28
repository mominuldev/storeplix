import type {
  HelpArticle,
  HelpArticleLink,
  HelpCategory,
  HelpHome,
  HelpSearchMeta,
  HelpSearchResult,
  SupportAttachment,
  SupportTicket,
  SupportTicketListMeta,
  SupportTicketMessage,
  SupportTicketSummary,
} from '@storeplix/types';

// PHASE-8-9C fixtures (shapes from packages/types, openapi 1.26.0).

export function category(o: Partial<HelpCategory> = {}): HelpCategory {
  return { id: 'HC1', slug: 'couriers', name: 'Couriers', description: 'Steadfast, Pathao, RedX', icon: 'truck', article_count: 24, position: 1, ...o };
}

export function link(o: Partial<HelpArticleLink> = {}): HelpArticleLink {
  return {
    id: 'HA1',
    slug: 'book-steadfast',
    title: 'How to book a parcel with Steadfast',
    summary: 'Send confirmed orders to Steadfast.',
    language: 'en',
    category: { id: 'HC1', slug: 'couriers', name: 'Couriers' },
    read_minutes: 3,
    updated_at: '2026-11-12T04:00:00Z',
    ...o,
  };
}

export function home(o: Partial<HelpHome> = {}): HelpHome {
  return {
    categories: [category(), category({ id: 'HC2', slug: 'orders-cod', name: 'Orders & COD', description: 'Confirm, cancel, returns', icon: 'cart', article_count: 28 })],
    total_articles: 52,
    popular: [
      link(),
      link({ id: 'HA2', slug: 'cod-money', title: 'When does the courier pay my COD money?' }),
      link({ id: 'HA3', slug: 'bkash-pgw', title: 'Connect bKash PGW' }),
      link({ id: 'HA4', slug: 'fake-orders', title: 'Stop fake orders' }),
      link({ id: 'HA5', slug: 'domain', title: 'Point your own domain' }),
    ],
    can_contact_support: true,
    ...o,
  };
}

export function article(o: Partial<HelpArticle> = {}): HelpArticle {
  return {
    id: 'HA1',
    slug: 'book-steadfast',
    language: 'en',
    requested_language: 'en',
    fallback: false,
    available_languages: ['en'],
    title: 'How to book a parcel with Steadfast',
    summary: 'Send confirmed orders to Steadfast without copying addresses.',
    body: {
      type: 'doc',
      content: [
        { type: 'callout', attrs: { tone: 'info' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before you start: you need a Steadfast account.' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Connect Steadfast' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Go to ' },
            { type: 'text', text: 'the courier guide', marks: [{ type: 'link', attrs: { href: '/help/articles/couriers' } }] },
            { type: 'text', text: ' or the ' },
            { type: 'text', text: 'Steadfast portal', marks: [{ type: 'link', attrs: { href: 'https://portal.steadfast.com.bd' } }] },
          ],
        },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Select confirmed orders' }] }] }] },
        { type: 'image', attrs: { media_id: 'HM1', alt: 'Courier settings screen', caption: 'Integrations › Couriers' } },
      ],
    },
    toc: [{ id: '1-connect-steadfast', text: 'Connect Steadfast', level: 2 }],
    media: { HM1: { id: 'HM1', status: 'ready', url: 'https://cdn.test/help/HM1/w1600.webp', width: 1600, height: 900, variants: { w640: 'https://cdn.test/help/HM1/w640.webp' }, alt: 'Courier settings screen' } },
    category: { id: 'HC1', slug: 'couriers', name: 'Couriers' },
    read_minutes: 3,
    updated_at: '2026-11-12T04:00:00Z',
    helpful: { yes_count: 214, my_vote: null },
    related: [link({ id: 'HA9', slug: 'track-steadfast', title: 'Track Steadfast parcels & COD' })],
    ...o,
  };
}

export function result(o: Partial<HelpSearchResult> = {}): HelpSearchResult {
  return {
    article_id: 'HA7',
    slug: 'bkash-refund',
    language: 'en',
    title: 'Refund a bKash payment to a customer',
    snippet: 'Open the order, click Refund and choose bKash.',
    category: { id: 'HC3', slug: 'payments', name: 'Payments & gateways' },
    read_minutes: 4,
    ...o,
  };
}

export function searchMeta(o: Partial<HelpSearchMeta> = {}): HelpSearchMeta {
  return {
    current_page: 1,
    per_page: 20,
    total: 2,
    last_page: 1,
    query: 'bkash refund',
    counts_by_category: [
      { category: { id: 'HC3', slug: 'payments', name: 'Payments & gateways' }, count: 1 },
      { category: { id: 'HC2', slug: 'orders-cod', name: 'Orders & COD' }, count: 1 },
    ],
    ...o,
  };
}

export function ticketSummary(o: Partial<SupportTicketSummary> = {}): SupportTicketSummary {
  return {
    id: 'ST1',
    number: 2381,
    reference: 'T-2381',
    subject: 'Steadfast booking fails for Chattogram orders',
    category: 'shipping_couriers',
    priority: 'high',
    status: 'awaiting_merchant',
    related_order: { id: 'O1', number: 'GS-1047' },
    requester: { id: 'U1', name: 'Rahim Ahmed' },
    last_reply: { author: { id: 'P1', name: 'Farhana · Store Plix', is_staff: true }, at: new Date(Date.now() - 12 * 60_000).toISOString() },
    created_at: '2026-11-18T04:05:00Z',
    updated_at: '2026-11-18T04:20:00Z',
    ...o,
  };
}

export function ticketMeta(o: Partial<SupportTicketListMeta> = {}): SupportTicketListMeta {
  return {
    current_page: 1,
    per_page: 20,
    total: 2,
    last_page: 1,
    counts: { all: 9, open: 2, waiting_on_you: 1, solved: 6 },
    stats: { open: 2, waiting_on_you: 1, solved_this_month: 6, avg_first_reply_seconds: 240, csat_average: 4.9, csat_count: 5 },
    ...o,
  };
}

export function attachment(o: Partial<SupportAttachment> = {}): SupportAttachment {
  return { id: 'SA1', filename: 'steadfast-error.png', mime: 'image/png', size_bytes: 180_000, kind: 'image', status: 'ready', ...o };
}

export function ticket(o: Partial<SupportTicket> = {}): SupportTicket {
  return {
    ...ticketSummary(),
    assignee_name: 'Farhana',
    order_card: { id: 'O1', number: 'GS-1047', status: 'shipped', total_amount: 245_000, currency: 'BDT', placed_at: '2026-11-17T08:00:00Z' },
    shop: { name: 'Mugdho Fashion', domain: 'mugdho.storeplix.com' },
    first_staff_reply_at: '2026-11-18T04:11:00Z',
    first_reply_seconds: 360,
    resolved_at: null,
    resolution_seconds: null,
    closed_at: null,
    rating: null,
    files: [attachment()],
    can: { reply: true, resolve: true, rate: false },
    revision: 3,
    ...o,
  };
}

export function messages(): SupportTicketMessage[] {
  return [
    { id: 'M1', kind: 'merchant', body: 'Since this morning every Chattogram order fails.', author: { id: 'U1', name: 'Rahim Ahmed', is_staff: false }, attachments: [attachment()], system: null, created_at: '2026-11-18T04:05:00Z' },
    { id: 'M2', kind: 'system', body: null, author: null, attachments: [], system: { event: 'assigned', actor_name: 'Farhana' }, created_at: '2026-11-18T04:09:00Z' },
    { id: 'M3', kind: 'staff', body: 'Thanks Rahim! I checked GS-1047.', author: { id: 'P1', name: 'Farhana · Store Plix', is_staff: true }, attachments: [], system: null, created_at: '2026-11-18T04:11:00Z' },
    { id: 'M4', kind: 'system', body: null, author: null, attachments: [], system: { event: 'reopened' }, created_at: '2026-11-18T04:15:00Z' },
    { id: 'M5', kind: 'system', body: null, author: null, attachments: [], system: { event: 'rated' }, created_at: '2026-11-18T04:16:00Z' },
  ];
}
