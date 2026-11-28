import type { AdminHelpArticle, AdminHelpArticleSummary, AdminHelpCategory, AdminHelpTranslation } from '@storeplix/types';
import { jsonResponse } from '../test/utils';

export function category(overrides: Partial<AdminHelpCategory> = {}): AdminHelpCategory {
  return {
    id: 'C1',
    slug: 'couriers',
    name_en: 'Couriers',
    name_bn: 'কুরিয়ার',
    description_en: 'Book and track parcels',
    description_bn: null,
    icon: 'truck',
    position: 1,
    article_counts: { published: 3, total: 4 },
    updated_at: '2026-11-20T04:00:00Z',
    revision: 1,
    ...overrides,
  };
}

export const categories = [
  category(),
  category({ id: 'C2', slug: 'payments', name_en: 'Payments', name_bn: null, icon: 'card', position: 2, article_counts: { published: 0, total: 0 } }),
  category({ id: 'C3', slug: 'online-store', name_en: 'Online store', icon: 'globe', position: 3, article_counts: { published: 1, total: 1 } }),
];

export function summary(overrides: Partial<AdminHelpArticleSummary> = {}): AdminHelpArticleSummary {
  return {
    id: 'A1',
    slug: 'book-steadfast-parcel',
    title: 'How to book a parcel with Steadfast',
    category: { id: 'C1', name: 'Couriers' },
    languages: { en: 'published', bn: 'published' },
    status: 'published',
    scheduled_at: null,
    has_unpublished_changes: false,
    helpful: { percent: 92, votes: 232 },
    views_7d: 120,
    updated_at: '2026-11-12T04:00:00Z',
    updated_by: { id: 'U2', name: 'Nusrat Jahan' },
    ...overrides,
  };
}

export function translation(overrides: Partial<AdminHelpTranslation> = {}): AdminHelpTranslation {
  return {
    language: 'en',
    title: 'How to book a parcel with Steadfast',
    summary: 'Send confirmed orders to Steadfast without copying addresses.',
    body: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Connect Steadfast' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Go to Integrations and paste your API key.' }] },
      ],
    },
    keywords: ['steadfast', 'book courier'],
    complete: true,
    published: true,
    has_unpublished_changes: false,
    published_at: '2026-11-12T04:00:00Z',
    word_count: 10,
    read_minutes: 1,
    ...overrides,
  };
}

export function article(overrides: Partial<AdminHelpArticle> = {}): AdminHelpArticle {
  return {
    id: 'A1',
    slug: 'book-steadfast-parcel',
    status: 'published',
    scheduled_at: null,
    category_id: 'C1',
    related_article_ids: ['A2'],
    related: [{ id: 'A2', slug: 'track-steadfast', title: 'Track Steadfast parcels', status: 'published' }],
    translations: { en: translation(), bn: null },
    media: {},
    feedback: { yes: 214, no: 18, helpful_percent_30d: 92, votes_30d: 232, top_reasons: [{ reason: 'steps_mismatch', count: 9 }] },
    views_7d: 120,
    merchant_path: '/help/articles/book-steadfast-parcel',
    first_published_at: '2026-11-01T04:00:00Z',
    last_published_at: '2026-11-12T04:00:00Z',
    last_published_by: { id: 'U2', name: 'Nusrat Jahan' },
    archived_at: null,
    created_at: '2026-11-01T04:00:00Z',
    updated_at: '2026-11-12T04:00:00Z',
    updated_by: { id: 'U2', name: 'Nusrat Jahan' },
    revision: 3,
    ...overrides,
  };
}

export const articlePage = (rows: AdminHelpArticleSummary[], meta: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    data: rows,
    meta: {
      current_page: 1,
      per_page: 25,
      total: rows.length,
      last_page: 1,
      counts: { all: 158, published: 146, draft: 12, scheduled: 1, archived: 3, missing_bn: 4 },
      stats: { published: 146, drafts: 12, missing_bn: 4, helpful_percent_30d: 87 },
      ...meta,
    },
  });
