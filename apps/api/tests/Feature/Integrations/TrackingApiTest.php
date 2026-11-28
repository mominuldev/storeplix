<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Stores\Models\Store;
use App\Domain\Tracking\TrackingTestMode;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9D §5.6–§5.8, §6 (S333, S335, S348): event log (filters, cursor, no payloads, deduplicated), stats, send test
 * event, test mode link + token, the storefront beacon (key, draft 404, ≤ 20, catalogue pricing, unknown / foreign ids
 * dropped, consent, mirror rules) and StorefrontConfig.tracking (IDs only; null for draft / preview).
 */
#[Group('integrations')]
#[Group('tracking')]
class TrackingApiTest extends TestCase
{
    use IntegrationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpIntegrations();
    }

    public function test_event_log_filters_cursor_and_never_exposes_payloads(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('log');
        [, $variant] = $this->stocked($h, $store, 50000, 80);
        $this->connect($h, $store, 'meta_pixel')->assertOk();
        $orders = [];
        for ($i = 0; $i < 3; $i++) {
            $orders[] = $id = $this->trackedOrder($store, $variant, ['consent' => 'granted', 'fbp' => 'fb.1.1700000000000.42']);
            $this->confirm($h, $store, $id);
        }
        $this->beacon($store, [self::browserEvent('page_view'), self::browserEvent('view_item', ['variant_id' => $variant])])->assertStatus(202);

        $log = $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events'))->assertOk();
        $this->assertCount(5, $log->json('data'));
        $first = $log->json('data.0');
        $this->assertSame(['id', 'event', 'provider_event_name', 'event_id', 'channel', 'source', 'test', 'status', 'skip_reason', 'attempts', 'max_attempts',
            'next_attempt_at', 'http_status', 'error_code', 'order', 'page_path', 'value_amount', 'currency', 'deduplicated', 'created_at', 'delivered_at'], array_keys($first));
        $this->assertStringNotContainsString('payload', $log->getContent());
        $this->assertStringNotContainsString('fb.1.1700000000000.42', $log->getContent());
        $this->assertStringNotContainsString('203.0.113', $log->getContent());

        $purchases = $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?event=purchase&status=delivered&channel=server'))->assertOk()->json('data');
        $this->assertCount(3, $purchases);
        $this->assertNotNull($purchases[0]['order']['number']);
        $this->assertSame(5, $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?test=0'))->json('meta.per_page') === 50 ? 5 : 0);
        $this->assertCount(0, $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?status=failed'))->json('data'));
        $this->assertCount(2, $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?event=page_view,view_item'))->json('data'));
        $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?status=bogus'))->assertJsonValidationErrors(['status'], 'error.details');
        $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?since='.urlencode(now()->subDays(40)->toIso8601ZuluString())))->assertJsonValidationErrors(['since'], 'error.details');
        $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?since=yesterday-ish'))->assertJsonValidationErrors(['since'], 'error.details');
        // Unconnected tracker → empty log, not an error; feeds / AI → 404.
        $this->api($h, 'GET', $this->intUrl($store, '/ga4/events'))->assertOk()->assertJsonPath('data', []);
        $this->api($h, 'GET', $this->intUrl($store, '/meta_catalog/events'))->assertNotFound();

        // Cursor pages of 50.
        $integration = $this->integrationRow($tenant, $store, 'meta_pixel');
        $rows = [];
        for ($i = 0; $i < 55; $i++) {
            $rows[] = ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id, 'store_integration_id' => $integration->id,
                'provider' => 'meta_pixel', 'event_name' => 'page_view', 'provider_event_name' => 'PageView', 'event_id' => 'p'.$i, 'channel' => 'server',
                'source' => 'browser_mirror', 'test' => false, 'status' => 'delivered', 'attempts' => 1, 'created_at' => now()->subMinutes($i + 5), 'updated_at' => now()];
        }
        $this->platformTable('tracking_events')->insert($rows);
        $page1 = $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events'))->assertOk();
        $this->assertCount(50, $page1->json('data'));
        $page2 = $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?cursor='.$page1->json('meta.next_cursor')))->assertOk();
        $this->assertCount(10, $page2->json('data'));
        $this->assertSame([], array_intersect(array_column($page1->json('data'), 'id'), array_column($page2->json('data'), 'id')));
    }

    public function test_stats_count_browser_and_server_and_delivery_rate(): void
    {
        [, , $store, $h] = $this->liveShop('stats');
        [, $variant] = $this->stocked($h, $store, 50000, 80);
        $this->connect($h, $store, 'meta_pixel')->assertOk();
        $this->connect($h, $store, 'ga4')->assertOk();
        $order = $this->trackedOrder($store, $variant);
        $this->confirm($h, $store, $order);
        $this->beacon($store, [self::browserEvent('page_view'), self::browserEvent('page_view'), self::browserEvent('add_to_cart', ['variant_id' => $variant, 'quantity' => 2])])->assertStatus(202);

        $meta = $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/stats'))->assertOk()->json('data');
        $this->assertSame(7, $meta['days']);
        $rows = collect($meta['rows'])->keyBy('event');
        $this->assertSame(['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'], array_column($meta['rows'], 'event'));
        $this->assertSame([2, 2], [$rows['page_view']['browser'], $rows['page_view']['server_sent']]); // mirrored (Meta)
        $this->assertSame([0, 1], [$rows['purchase']['browser'], $rows['purchase']['server_sent']]);
        $this->assertSame(['browser' => 3, 'server_sent' => 4, 'server_failed' => 0, 'delivery_rate' => 1], $meta['totals']);

        $ga4 = collect($this->api($h, 'GET', $this->intUrl($store, '/ga4/stats?days=30'))->assertOk()->json('data.rows'))->keyBy('event');
        $this->assertSame([2, 0], [$ga4['page_view']['browser'], $ga4['page_view']['server_sent']]); // GA4 never mirrors (P89D-10)
        $this->assertArrayHasKey('refund', $ga4->all());
        $this->api($h, 'GET', $this->intUrl($store, '/ga4/stats?days=14'))->assertJsonValidationErrors(['days'], 'error.details');
        $this->assertNull($this->api($h, 'GET', $this->intUrl($store, '/tiktok_pixel/stats'))->assertOk()->json('data.totals.delivery_rate'));
    }

    public function test_send_test_event_is_logged_as_test_never_counted_and_audited(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('testevent');
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-event'))->assertUnprocessable()->assertJsonPath('error.code', 'integration_not_connected');
        $this->connect($h, $store, 'meta_pixel', ['test_event_code' => 'TEST1234'])->assertOk();
        $r = $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-event'))->assertOk()->json('data');
        $this->assertTrue($r['delivered']);
        $this->assertSame('purchase', $r['event']);
        $this->assertStringStartsWith('test.', $r['event_id']);
        $row = $this->trackingRows($tenant)->first();
        $this->assertSame([true, 'test', 'delivered', 100], [$row->test, $row->source, $row->status, $row->value_amount]);
        $this->assertSame(0, $this->platformTable('tracking_daily_stats')->count());
        $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?test=1'))->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.test', true);

        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-event'), ['event' => 'refund'])->assertJsonValidationErrors(['event'], 'error.details');
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-event'), ['event' => 'add_to_cart', 'test_event_code' => 'bad code!'])->assertJsonValidationErrors(['test_event_code'], 'error.details');
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-event'), ['event' => 'add_to_cart', 'test_event_code' => 'OTHER99'])->assertOk()->assertJsonPath('data.delivered', true);
        $this->connect($h, $store, 'ga4')->assertOk();
        $this->api($h, 'POST', $this->intUrl($store, '/ga4/test-event'), ['event' => 'refund'])->assertOk()->assertJsonPath('data.delivered', true);
        $audits = array_values(array_filter($this->audits($tenant), fn ($a) => $a['action'] === 'integration.test_event_sent'));
        $this->assertCount(3, $audits);
        $this->assertSame(['provider', 'store_id', 'event', 'event_id', 'delivered', 'error_code'], array_keys($audits[0]['meta']));
    }

    public function test_test_mode_link_token_and_beacon_test_rows(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('testmode');
        [, $variant] = $this->stocked($h, $store, 50000, 80);
        $this->connect($h, $store, 'meta_pixel')->assertOk();
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-mode'))->assertJsonValidationErrors(['test_event_code'], 'error.details');
        $this->api($h, 'PATCH', $this->intUrl($store, '/meta_pixel'), ['settings' => ['test_event_code' => 'TEST1234'], 'revision' => 1])->assertOk();
        $this->freezeSecond();
        $r = $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-mode'))->assertOk()->json('data');
        $this->assertStringStartsWith('https://'.$this->host($store).'/?sp_test=', $r['url']);
        $this->assertSame(now()->addMinutes(30)->toIso8601ZuluString(), $r['expires_at']);
        $token = Str::after($r['url'], 'sp_test=');
        $integration = $this->integrationRow($tenant, $store, 'meta_pixel');
        $this->assertSame($integration->id, TrackingTestMode::integrationFor($token, $store->id));
        $this->assertNull(TrackingTestMode::integrationFor($token, 'another-store-id'));
        $this->assertNull(TrackingTestMode::integrationFor($token.'x', $store->id));
        $this->assertNull(TrackingTestMode::integrationFor(strrev($token), $store->id));

        $event = self::browserEvent('add_to_cart', ['variant_id' => $variant]);
        $this->beacon($store, [$event], ['consent' => 'not_required', 'test_token' => $token])->assertStatus(202);
        $rows = $this->trackingRows($tenant)->where('event_id', $event['event_id'])->values();
        $this->assertSame([['browser', true, 'delivered'], ['server', true, 'delivered']], $rows->map(fn ($e) => [$e->channel, $e->test, $e->status])->sortBy(0)->values()->all());
        $log = $this->api($h, 'GET', $this->intUrl($store, '/meta_pixel/events?test=1'))->json('data');
        $this->assertSame([true, true], array_column($log, 'deduplicated'));
        $this->assertSame(0, $this->platformTable('tracking_daily_stats')->count()); // test events never count

        // Expired token → an ordinary (counted) event.
        $this->travel(31)->minutes();
        $this->assertNull(TrackingTestMode::integrationFor($token, $store->id));
        $this->beacon($store, [self::browserEvent('page_view')], ['consent' => 'not_required', 'test_token' => $token])->assertStatus(202);
        $this->assertSame(1, (int) $this->platformTable('tracking_daily_stats')->sum('browser_count'));
        $this->assertSame(['integration.test_mode_started'], array_values(array_filter(array_column($this->audits($tenant), 'action'), fn ($a) => str_contains($a, 'test_mode'))));

        // Not live → 409.
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_DRAFT]));
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-mode'))->assertStatus(409)->assertJsonPath('error.code', 'store_not_live');
    }

    #[Group('security')]
    public function test_beacon_key_draft_limits_pricing_and_foreign_ids(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('beacon');
        [, $tenantB, $storeB, $hB] = $this->liveShop('other');
        [, $variant] = $this->stocked($h, $store, 75000, 80);
        [, $foreign] = $this->stocked($hB, $storeB, 100, 80);
        $this->connect($h, $store, 'meta_pixel')->assertOk();

        $this->beacon($store, [self::browserEvent('page_view')], ['consent' => 'not_required'], ['X-Storefront-Key' => 'wrong'])->assertUnauthorized();
        $this->beacon($store, array_fill(0, 21, self::browserEvent('page_view')))->assertJsonValidationErrors(['events'], 'error.details');
        $this->beacon($store, [self::browserEvent('purchase')])->assertJsonValidationErrors(['events.0.name'], 'error.details');
        $this->beacon($store, [self::browserEvent('page_view', ['page_path' => 'https://evil.example/'])])->assertJsonValidationErrors(['events.0.page_path'], 'error.details');
        $this->beacon($store, [self::browserEvent('page_view')], [])->assertJsonValidationErrors(['context'], 'error.details');

        // Browser prices ignored (not in the schema): the API prices from the catalogue; unknown and foreign ids drop the event.
        $events = [
            self::browserEvent('add_to_cart', ['variant_id' => $variant, 'quantity' => 3, 'value' => 1, 'value_amount' => 1, 'price_amount' => 1]),
            self::browserEvent('view_item', ['variant_id' => $foreign]),
            self::browserEvent('view_item', ['variant_id' => strtoupper((string) Str::ulid())]),
            self::browserEvent('view_item', ['product_id' => $this->inTenant($tenantB, fn () => ProductVariant::query()->whereKey($foreign)->value('product_id'))]),
        ];
        $this->beacon($store, $events)->assertStatus(202)->assertNoContent(202);
        $rows = $this->trackingRows($tenant);
        $this->assertSame([[$events[0]['event_id'], 225000, 'BDT']], $rows->map(fn ($e) => [$e->event_id, $e->value_amount, $e->currency])->all());
        $this->assertSame(0, $this->trackingRows($tenantB)->count());

        // Draft store → 404 (and nothing recorded).
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_DRAFT]));
        Cache::flush();
        $this->beacon($store, [self::browserEvent('page_view')])->assertNotFound();
    }

    public function test_beacon_consent_and_mirror_rules_per_provider(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('mirror');
        $this->planFor($tenant, 'growth');
        [, $variant] = $this->stocked($h, $store, 50000, 80);
        $this->connect($h, $store, 'meta_pixel', ['wait_for_consent' => true])->assertOk();
        $this->connect($h, $store, 'tiktok_pixel', ['mirror_browser_events' => false])->assertOk();
        $this->connect($h, $store, 'ga4')->assertOk();
        $this->connect($h, $store, 'gtm_server', ['events' => ['add_to_cart', 'purchase']])->assertOk();

        $this->beacon($store, [self::browserEvent('page_view'), self::browserEvent('add_to_cart', ['variant_id' => $variant])], ['consent' => 'denied'])->assertStatus(202);
        // Meta waits for consent: nothing counted or mirrored. TikTok counts, no mirror. GA4 counts, never mirrors. GTM mirrors selected events only.
        $this->assertSame(['gtm_server' => ['add_to_cart']], $this->trackingRows($tenant)->groupBy('provider')->map(fn ($g) => $g->pluck('event_name')->all())->all());
        $browser = $this->platformTable('tracking_daily_stats')->get()->groupBy('store_integration_id')->map(fn ($g) => (int) $g->sum('browser_count'));
        $ids = collect(['meta_pixel', 'tiktok_pixel', 'ga4', 'gtm_server'])->mapWithKeys(fn ($p) => [$p => $this->integrationRow($tenant, $store, $p)->id]);
        $this->assertSame([0, 2, 2, 1], [$browser[$ids['meta_pixel']] ?? 0, $browser[$ids['tiktok_pixel']] ?? 0, $browser[$ids['ga4']] ?? 0, $browser[$ids['gtm_server']] ?? 0]);

        $accepted = self::browserEvent('page_view');
        $this->beacon($store, [$accepted], ['consent' => 'granted', 'fbp' => 'fb.1.1700000000000.99'])->assertStatus(202);
        $meta = $this->trackingRows($tenant, 'meta_pixel');
        $this->assertSame([[$accepted['event_id'], 'server', 'browser_mirror', 'delivered']], $meta->map(fn ($e) => [$e->event_id, $e->channel, $e->source, $e->status])->all());
        // Replaying the same event id (browser retry) mirrors once (S336).
        $this->beacon($store, [$accepted], ['consent' => 'granted'])->assertStatus(202);
        $this->assertSame(1, $this->trackingRows($tenant, 'meta_pixel')->count());
    }

    #[Group('security')]
    public function test_storefront_config_tracking_holds_ids_only_and_is_null_for_draft_and_preview(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('sfconfig');
        $this->planFor($tenant, 'growth');
        $this->connect($h, $store, 'meta_pixel', ['test_event_code' => 'SECRETTEST1'])->assertOk();
        $this->connect($h, $store, 'ga4', ['wait_for_consent' => true])->assertOk();
        $this->connect($h, $store, 'tiktok_pixel')->assertOk();
        $this->connect($h, $store, 'gtm_server')->assertOk();
        Cache::flush();

        $config = $this->sf($store, 'GET', '/config')->assertOk();
        $this->assertSame([
            'meta_pixel_id' => self::META_PIXEL, 'ga4_measurement_id' => 'G-ABC123XYZ', 'tiktok_pixel_id' => self::TIKTOK_PIXEL,
            'wait_for_consent' => true, 'collect' => true, 'currency' => 'BDT', 'site_verification' => ['google' => null],
        ], $config->json('data.tracking'));
        foreach ([self::META_TOKEN, self::GA4_SECRET, self::TIKTOK_TOKEN, 'SECRETTEST1', 'sgtm.example.com', 'GTM-ABCD12'] as $secret) {
            $this->assertStringNotContainsString($secret, $config->getContent());
        }

        // Preview render → no tracking.
        $token = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/preview-token")->assertCreated()->json('data.token');
        $preview = $this->sf($store, 'GET', '/config', [], null, ['X-Storefront-Preview' => $token])->assertOk();
        $this->assertTrue($preview->json('data.preview'));
        $this->assertArrayNotHasKey('tracking', $preview->json('data'));

        // Coming soon (draft) → no tracking.
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_DRAFT]));
        Cache::flush();
        $this->assertArrayNotHasKey('tracking', $this->sf($store, 'GET', '/config')->assertOk()->json('data'));

        // Everything disconnected → the key is gone again (byte-identical config, S349).
        $this->inTenant($tenant, fn () => Store::query()->whereKey($store->id)->update(['status' => Store::STATUS_ACTIVE]));
        foreach (['meta_pixel', 'ga4', 'tiktok_pixel', 'gtm_server'] as $p) {
            $this->api($h, 'POST', $this->intUrl($store, "/{$p}/disconnect"), ['confirm' => 'DISCONNECT'])->assertOk();
        }
        Cache::flush();
        $this->assertArrayNotHasKey('tracking', $this->sf($store, 'GET', '/config')->assertOk()->json('data'));
    }

    #[Group('security')]
    public function test_abuse_limits_on_verify_test_and_beacon(): void
    {
        $this->app->forgetInstance(ThrottleRequests::class); // limiters on for this test
        [, , $store, $h] = $this->liveShop('limits');
        $this->connect($h, $store, 'meta_pixel', ['test_event_code' => 'TEST1234'])->assertOk();
        for ($i = 0; $i < 10; $i++) {
            $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/verify'))->assertOk();
        }
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/verify'))->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        for ($i = 0; $i < 10; $i++) {
            $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-event'))->assertOk();
        }
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/test-mode'))->assertStatus(429);

        config(['tracking.beacon_per_ip_per_minute' => 3]);
        $ip = ['X-Storefront-Client-Ip' => '198.51.100.7'];
        for ($i = 0; $i < 3; $i++) {
            $this->beacon($store, [self::browserEvent('page_view')], ['consent' => 'not_required'], $ip)->assertStatus(202);
        }
        $this->beacon($store, [self::browserEvent('page_view')], ['consent' => 'not_required'], $ip)->assertStatus(429);
        $this->beacon($store, [self::browserEvent('page_view')], ['consent' => 'not_required'], ['X-Storefront-Client-Ip' => '198.51.100.8'])->assertStatus(202);
    }
}
