import type {
  CatalogItem,
  CatalogSyncRun,
  FeedOverview,
  IntegrationCheck,
  IntegrationProvider,
  IntegrationSettingsMap,
  IntegrationSummary,
  StoreIntegration,
  TrackingEventLogEntry,
  TrackingEventStats,
} from '@storeplix/types';

// PHASE-8-9D part A fixtures (tracking pixels, GTM server, product feeds).

const tracking = { purchase_trigger: 'order_confirmed' as const, include_delivery_charge: false, wait_for_consent: false, send_customer_data: true };
export const DEFAULTS: IntegrationSettingsMap = {
  meta_pixel: { ...tracking, pixel_id: '', mirror_browser_events: true, test_event_code: null },
  ga4: { ...tracking, measurement_id: '', send_refunds: true },
  tiktok_pixel: { ...tracking, pixel_id: '', mirror_browser_events: true, test_event_code: null },
  gtm_server: { ...tracking, container_id: '', tagging_server_url: '', measurement_id: '', events: ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'] },
  meta_catalog: { include: 'all', category_ids: [], hide_sold_out: false, use_sale_price: true, business_id: null, business_name: null, catalog_id: null, catalog_name: null, default_brand: null },
  google_merchant: { include: 'all', category_ids: [], hide_sold_out: false, use_sale_price: true, merchant_id: null, account_name: null, website_claimed: false, feed_language: 'bn', condition: 'new' },
  ai_writer: { default_language: 'bn', default_tone: 'friendly', default_length: 'medium', use_product_image: true },
  ai_photos: { default_background: 'studio_white', keep_originals_days: 30 },
};

const can = { manage: true, send_test: true, view_events: true, sync_now: true };

export function integration<P extends IntegrationProvider>(provider: P, o: Partial<StoreIntegration<P>> = {}): StoreIntegration<P> {
  const kind = provider === 'meta_catalog' || provider === 'google_merchant' ? 'feed' : provider.startsWith('ai_') ? 'ai' : 'tracking';
  return {
    provider,
    kind,
    status: 'not_connected',
    settings: null,
    defaults: DEFAULTS[provider],
    credentials_hint: {},
    token_expires_at: null,
    attention: [],
    last_verified_at: null,
    last_error_code: null,
    connected_by: null,
    connected_at: null,
    plan_required: null,
    can,
    revision: 1,
    ...o,
  } as StoreIntegration<P>;
}

export function connected<P extends IntegrationProvider>(provider: P, settings: Partial<IntegrationSettingsMap[P]>, o: Partial<StoreIntegration<P>> = {}): StoreIntegration<P> {
  return integration(provider, {
    status: 'connected',
    settings: { ...DEFAULTS[provider], ...settings } as IntegrationSettingsMap[P],
    connected_at: '2026-11-12T08:00:00Z',
    connected_by: { id: 'U1', name: 'Rahim Ahmed' } as StoreIntegration['connected_by'],
    revision: 3,
    ...o,
  });
}

export function summary(provider: IntegrationProvider, o: Partial<IntegrationSummary> = {}): IntegrationSummary {
  const kind = provider === 'meta_catalog' || provider === 'google_merchant' ? 'feed' : provider.startsWith('ai_') ? 'ai' : 'tracking';
  return { provider, kind, status: 'not_connected', summary: null, plan_required: null, attention: [], ...o };
}

export function stats(o: Partial<TrackingEventStats> = {}): TrackingEventStats {
  return {
    provider: 'ga4',
    days: 7,
    from: '2026-11-21',
    to: '2026-11-28',
    rows: [
      { event: 'page_view', provider_event_name: 'page_view', browser: 18420, server_sent: 0, server_failed: 0, server_skipped: 0, last_at: '2026-11-28T08:00:00Z' },
      { event: 'purchase', provider_event_name: 'purchase', browser: 0, server_sent: 412, server_failed: 2, server_skipped: 0, last_at: '2026-11-28T08:00:00Z' },
    ],
    totals: { browser: 18420, server_sent: 412, server_failed: 2, delivery_rate: 0.995 },
    ...o,
  };
}

export function logEntry(o: Partial<TrackingEventLogEntry> = {}): TrackingEventLogEntry {
  return {
    id: 'E1',
    event: 'purchase',
    provider_event_name: 'Purchase',
    event_id: 'purchase.O1',
    channel: 'server',
    source: 'order',
    test: false,
    status: 'delivered',
    skip_reason: null,
    attempts: 1,
    max_attempts: 5,
    next_attempt_at: null,
    http_status: 200,
    error_code: null,
    order: { id: 'O1', number: 'GS-1043' },
    page_path: null,
    value_amount: 245000,
    currency: 'BDT',
    deduplicated: false,
    created_at: '2026-11-28T08:32:08Z',
    delivered_at: '2026-11-28T08:32:09Z',
    ...o,
  };
}

export const cursorMeta = (next: string | null = null) => ({ next_cursor: next, prev_cursor: null, per_page: 50 });

export function check(o: Partial<IntegrationCheck> = {}): IntegrationCheck {
  return {
    provider: 'ga4',
    ok: true,
    checked_at: '2026-11-28T08:00:00Z',
    rows: [
      { key: 'id_format', label: 'Measurement ID found', state: 'ok', detail: null },
      { key: 'token', label: 'API secret accepted', state: 'ok', detail: null },
    ],
    found_name: null,
    ...o,
  };
}

export function run(o: Partial<CatalogSyncRun> = {}): CatalogSyncRun {
  return { id: 'R1', kind: 'full', trigger: 'schedule', status: 'done', items_sent: 410, items_failed: 2, items_deleted: 0, error_code: null, started_at: '2026-11-28T08:20:00Z', finished_at: '2026-11-28T08:22:00Z', ...o };
}

export function feedOverview(o: Partial<FeedOverview> = {}): FeedOverview {
  return {
    provider: 'meta_catalog',
    counts: { total: 412, approved: 404, in_review: 6, with_issues: 2, not_sent: 18 },
    issues: [{ code: 'image_too_small', message: 'Image is smaller than 500 × 500 px', severity: 'error', impact: 'disapproved', products: 1, fix: 'product_editor' }],
    last_run: run(),
    next_full_sync_at: '2026-11-28T09:20:00Z',
    clicks_30d: null,
    ...o,
  };
}

export function item(o: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'CI1',
    product: { id: 'P1', name: 'Jamdani Three-Piece', slug: 'jamdani' },
    variant: { id: 'V1', title: 'Red / XL', sku: 'JT-RD-XL' },
    status: 'error',
    review_status: 'disapproved',
    excluded_reason: null,
    issues: [{ code: 'image_too_small', severity: 'error', message: 'Image is smaller than 500 × 500 px. Meta rejects small photos.', attribute: 'image_link', fix: 'product_editor' }],
    last_synced_at: '2026-11-28T08:20:00Z',
    ...o,
  };
}

export const itemMeta = (o: Partial<{ next_cursor: string | null }> = {}) => ({
  ...cursorMeta(o.next_cursor ?? null),
  counts: { total: 412, approved: 404, in_review: 6, with_issues: 2, not_sent: 18 },
});
