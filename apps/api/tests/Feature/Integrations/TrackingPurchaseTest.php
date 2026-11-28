<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Integrations\IntegrationAttention;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Orders\Models\Order;
use App\Domain\Tracking\Jobs\DeliverTrackingEvent;
use App\Domain\Tracking\Models\TrackingEvent;
use App\Domain\Tracking\TrackingDelivery;
use App\Domain\Tracking\TrackingRecorder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9D §5.3–§5.5 (P89D-11/12/13/14/20/21): server purchase on the configured trigger, once per destination
 * (S336), hashed customer data and nothing raw (S337), consent matrix, POS / cancelled excluded, refunds to GA4 / GTM
 * only after a delivered purchase, checkout tracking context only for stores with tracking, and the opt-in rule (S349).
 */
#[Group('integrations')]
#[Group('tracking')]
class TrackingPurchaseTest extends TestCase
{
    use IntegrationFixtures, RefreshDatabase;

    private const CONTEXT = ['consent' => 'granted', 'fbp' => 'fb.1.1700000000000.1234567890', 'fbc' => 'fb.1.1700000000000.IwAR0abc', 'ttp' => 'ttp-cookie.1',
        'ttclid' => 'E.C.P.abc123', 'ga_client_id' => '1234567890.1700000000', 'ga_session_id' => '1700000000', 'user_agent' => 'Mozilla/5.0 (Test)'];

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpIntegrations();
    }

    #[Group('security')]
    public function test_a_shop_that_connects_nothing_sees_no_change(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('nothing');
        [, $variant] = $this->stocked($h, $store);
        $before = $this->sf($store, 'GET', '/config')->assertOk()->json('data');
        $this->assertArrayNotHasKey('tracking', $before);

        $order = $this->trackedOrder($store, $variant, self::CONTEXT);
        $this->confirm($h, $store, $order);
        $this->beacon($store, [self::browserEvent('page_view')])->assertStatus(202);

        $this->assertNull($this->contextRow($tenant, $order)); // S337: no context without tracking
        $this->assertSame(0, $this->trackingRows($tenant)->count());
        $this->assertSame(0, $this->platformTable('tracking_daily_stats')->count());
        $this->assertSame(0, $this->platformTable('store_integrations')->count());
        $this->assertSame($before, $this->sf($store, 'GET', '/config')->json('data'));
    }

    public function test_purchase_on_confirm_once_per_tracker_with_hashed_customer_data(): void
    {
        Queue::fake([DeliverTrackingEvent::class]);
        [, $tenant, $store, $h] = $this->liveShop('purchase');
        $this->planFor($tenant, 'growth');
        [, $variant] = $this->stocked($h, $store, 100000);
        foreach (['meta_pixel', 'ga4', 'tiktok_pixel', 'gtm_server'] as $provider) {
            $this->connect($h, $store, $provider)->assertOk();
        }
        $order = $this->trackedOrder($store, $variant, self::CONTEXT, ['contact' => ['email' => ' Rafi@Example.COM ']]);
        $this->assertSame(0, $this->trackingRows($tenant)->count(), 'default trigger is order_confirmed');
        $ctx = $this->contextRow($tenant, $order);
        $this->assertSame(['granted', 'fb.1.1700000000000.1234567890', '1234567890.1700000000'], [$ctx->consent, $ctx->fbp, $ctx->ga_client_id]);
        $this->assertNotNull($ctx->client_ip);

        $this->confirm($h, $store, $order);
        $rows = $this->trackingRows($tenant);
        $this->assertSame(['meta_pixel', 'ga4', 'tiktok_pixel', 'gtm_server'], $rows->pluck('provider')->all());
        $this->assertSame(['Purchase', 'purchase', 'CompletePayment', 'purchase'], $rows->pluck('provider_event_name')->all());
        $this->assertSame(["purchase.{$order}"], $rows->pluck('event_id')->unique()->values()->all());
        $this->assertSame([100000], $rows->pluck('value_amount')->unique()->values()->all()); // total − delivery (P89D-21)
        Queue::assertPushed(DeliverTrackingEvent::class, 4);

        $meta = $rows->firstWhere('provider', 'meta_pixel');
        $raw = (string) $this->platformTable('tracking_events')->where('id', $meta->id)->value('payload');
        $payload = json_decode($raw, true);
        $this->assertSame(hash('sha256', 'rafi@example.com'), $payload['user']['em']);
        $this->assertSame(hash('sha256', '+8801711000001'), $payload['user']['ph']);
        $this->assertSame(hash('sha256', '8801711000001'), $payload['user']['ph_meta']); // Meta: digits without "+"
        $this->assertSame(hash('sha256', 'rafi'), $payload['user']['fn']);
        $this->assertSame(hash('sha256', 'ahmed'), $payload['user']['ln']);
        $this->assertSame(hash('sha256', 'bd'), $payload['user']['country']);
        $this->assertSame(['fb.1.1700000000000.1234567890', 'Mozilla/5.0 (Test)'], [$payload['client']['fbp'], $payload['client']['ua']]);
        $this->assertSame('1234567890.1700000000', $payload['client_id']);
        // S337: raw email / phone / name never stored in tracking_events.
        $all = (string) json_encode($this->platformTable('tracking_events')->get()->all());
        foreach (['rafi@example.com', 'Rafi@Example.COM', '01711000001', '8801711000001', 'Rafi Ahmed'] as $needle) {
            $this->assertStringNotContainsString($needle, $all);
        }

        // Replays: the hook again, a second confirm path, the recorder directly → still one row per destination (S336).
        $this->inTenant($tenant, function () use ($order) {
            $o = Order::query()->findOrFail($order);
            TrackingRecorder::purchase($o, ['order_placed', 'order_confirmed', 'order_delivered']);
            TrackingRecorder::purchase($o, ['order_confirmed']);
        });
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order}/ship", ['notify_customer' => false])->assertOk();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order}/deliver", ['notify_customer' => false])->assertOk();
        $this->assertSame(4, $this->trackingRows($tenant)->count());
        Queue::assertPushed(DeliverTrackingEvent::class, 4);

        // Delivery (sweep, fake driver) → delivered, payload nulled (P89D-18), stats counted.
        $this->inTenant($tenant, function () use ($tenant) {
            foreach ($this->trackingRows($tenant) as $row) {
                app(TrackingDelivery::class)->attempt($row->id);
            }
        });
        $this->assertSame(['delivered'], $this->trackingRows($tenant)->pluck('status')->unique()->values()->all());
        $this->assertSame(0, $this->platformTable('tracking_events')->whereNotNull('payload')->count());
        $this->assertSame(4, (int) $this->platformTable('tracking_daily_stats')->where('event_name', 'purchase')->sum('server_sent'));
    }

    public function test_trigger_matrix_placed_delivered_cancelled_and_pos(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('triggers');
        [, $variant] = $this->stocked($h, $store, 50000, 50);
        $this->connect($h, $store, 'meta_pixel', ['purchase_trigger' => 'order_placed'])->assertOk();
        $this->connect($h, $store, 'ga4', ['purchase_trigger' => 'order_delivered'])->assertOk();

        $placed = $this->trackedOrder($store, $variant);
        $this->assertSame(['meta_pixel'], $this->trackingRows($tenant)->pluck('provider')->all());
        $this->assertSame('delivered', $this->trackingRows($tenant)->first()->status);

        $this->confirm($h, $store, $placed);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$placed}/ship", ['notify_customer' => false])->assertOk();
        $this->assertSame(1, $this->trackingRows($tenant)->count());
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$placed}/deliver", ['notify_customer' => false])->assertOk();
        $this->assertSame(['meta_pixel', 'ga4'], $this->trackingRows($tenant)->pluck('provider')->all());

        // Cancelled before the trigger → nothing for GA4 (delivered trigger).
        $cancelled = $this->trackedOrder($store, $variant);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$cancelled}/cancel", ['reason' => 'customer_request', 'notify_customer' => false])->assertOk();
        $this->assertSame(0, $this->trackingRows($tenant, 'ga4')->where('order_id', $cancelled)->count());

        // Manual (merchant-entered) orders count too; POS till sales never.
        $manual = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $this->assertSame(1, $this->trackingRows($tenant, 'meta_pixel')->where('order_id', $manual)->count());
        $pos = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $this->platformTable('tracking_events')->where('order_id', $pos)->delete();
        $this->inTenant($tenant, function () use ($pos) {
            Order::query()->whereKey($pos)->update(['created_via' => Order::VIA_POS]);
            $o = Order::query()->findOrFail($pos);
            TrackingRecorder::purchase($o, ['order_placed', 'order_confirmed', 'order_delivered']);
        });
        $this->confirm($h, $store, $pos);
        $this->assertSame(0, $this->trackingRows($tenant)->where('order_id', $pos)->count());
    }

    public function test_consent_matrix_and_customer_data_switch(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('consent');
        [, $variant] = $this->stocked($h, $store, 50000, 50);
        Queue::fake([DeliverTrackingEvent::class]);
        $this->connect($h, $store, 'meta_pixel', ['wait_for_consent' => true])->assertOk();
        $this->connect($h, $store, 'ga4', ['send_customer_data' => false])->assertOk();

        $cases = ['granted' => self::CONTEXT, 'denied' => ['consent' => 'denied'] + self::CONTEXT, 'none' => []];
        $orders = [];
        foreach ($cases as $key => $context) {
            $orders[$key] = $this->trackedOrder($store, $variant, $context);
            $this->confirm($h, $store, $orders[$key]);
        }
        $meta = $this->trackingRows($tenant, 'meta_pixel')->keyBy('order_id');
        $this->assertSame(['pending', null], [$meta[$orders['granted']]->status, $meta[$orders['granted']]->skip_reason]);
        $this->assertSame(['skipped', 'no_consent'], [$meta[$orders['denied']]->status, $meta[$orders['denied']]->skip_reason]);
        $this->assertSame(['skipped', 'no_consent'], [$meta[$orders['none']]->status, $meta[$orders['none']]->skip_reason]);
        $this->assertNull($this->platformTable('tracking_events')->where('id', $meta[$orders['denied']]->id)->value('payload'));

        // GA4 doesn't wait (recorded not_required by the storefront) → always sent; no customer block when switched off.
        $ga4 = $this->trackingRows($tenant, 'ga4');
        $this->assertSame(['pending'], $ga4->pluck('status')->unique()->values()->all());
        $payload = json_decode((string) $this->platformTable('tracking_events')->where('id', $ga4->first()->id)->value('payload'), true);
        $this->assertArrayNotHasKey('user', $payload);
        $this->assertSame(2, (int) $this->platformTable('tracking_daily_stats')->where('event_name', 'purchase')->sum('server_skipped'));
    }

    public function test_refunds_go_to_ga4_and_gtm_only_after_a_delivered_purchase(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('refunds');
        $this->planFor($tenant, 'growth');
        [, $variant] = $this->stocked($h, $store, 50000, 50);
        $fulfil = function (string $id) use ($h, $store) {
            foreach (['confirm', 'ship', 'deliver'] as $step) {
                $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/{$step}", ['notify_customer' => false])->assertOk();
            }
        };
        $refund = fn (string $id, int $amount) => $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST',
            "/api/v1/stores/{$store->id}/orders/{$id}/refunds", ['amount' => $amount, 'method' => 'cash'])->assertCreated()->json('data.id');

        // An order paid before tracking was connected has no delivered purchase → its refund sends nothing.
        $old = $this->trackedOrder($store, $variant);
        $fulfil($old);
        foreach (['meta_pixel', 'ga4', 'gtm_server'] as $provider) {
            $this->connect($h, $store, $provider)->assertOk();
        }
        $refund($old, 1000);
        $this->assertSame(0, $this->trackingRows($tenant)->count());

        $order = $this->trackedOrder($store, $variant);
        $fulfil($order);
        $payment = $refund($order, 2500);
        $rows = $this->trackingRows($tenant)->where('event_name', 'refund')->values();
        $this->assertSame(['ga4', 'gtm_server'], $rows->pluck('provider')->all()); // Meta has no refund event (P89D-20)
        $this->assertSame(["refund.{$payment}", 2500, 'delivered', 'refund'], [$rows[0]->event_id, $rows[0]->value_amount, $rows[0]->status, $rows[0]->source]);

        // GA4 with send_refunds off → none.
        $this->api($h, 'PATCH', $this->intUrl($store, '/ga4'), ['settings' => ['send_refunds' => false], 'revision' => 1])->assertOk();
        $refund($order, 500);
        $this->assertSame(['ga4', 'gtm_server', 'gtm_server'], $this->trackingRows($tenant)->where('event_name', 'refund')->pluck('provider')->values()->all());
    }

    public function test_checkout_context_drops_invalid_values_and_never_fails_checkout(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('context');
        [, $variant] = $this->stocked($h, $store);
        $this->connect($h, $store, 'tiktok_pixel')->assertOk();
        $order = $this->trackedOrder($store, $variant, ['consent' => 'maybe', 'fbp' => '<script>', 'ttclid' => str_repeat('a', 600), 'ga_client_id' => 'GA1.2.3',
            'user_agent' => "Bad\x01Agent", 'ttp' => 'ok_ttp-1']);
        $ctx = $this->contextRow($tenant, $order);
        $this->assertSame(['denied', null, null, null, 'ok_ttp-1', 'Bad Agent'], [$ctx->consent, $ctx->fbp, $ctx->ttclid, $ctx->ga_client_id, $ctx->ttp, $ctx->user_agent]);
        // A non-object tracking value is ignored (still 201).
        $order2 = $this->trackedOrder($store, $variant, [], ['tracking' => 'nope']);
        $this->assertNull($this->contextRow($tenant, $order2));
    }

    public function test_disconnect_skips_pending_events_and_error_rows_skip_no_token(): void
    {
        Queue::fake([DeliverTrackingEvent::class]);
        [, $tenant, $store, $h] = $this->liveShop('disc');
        [, $variant] = $this->stocked($h, $store, 50000, 50);
        $this->connect($h, $store, 'meta_pixel')->assertOk();
        $order = $this->trackedOrder($store, $variant);
        $this->confirm($h, $store, $order);
        $this->assertSame('pending', $this->trackingRows($tenant)->first()->status);
        $this->api($h, 'POST', $this->intUrl($store, '/meta_pixel/disconnect'), ['confirm' => 'DISCONNECT'])->assertOk();
        $row = $this->trackingRows($tenant)->first();
        $this->assertSame(['skipped', 'disabled'], [$row->status, $row->skip_reason]);
        $this->assertNull($this->platformTable('tracking_events')->where('id', $row->id)->value('payload'));

        // A token flagged invalid: later events are recorded skipped (no_token), never sent.
        $this->connect($h, $store, 'meta_pixel', [], null, $this->integrationRow($tenant, $store, 'meta_pixel')->revision)->assertOk();
        $this->inTenant($tenant, fn () => IntegrationAttention::apply(
            StoreIntegration::query()->where('store_id', $store->id)->where('provider', 'meta_pixel')->firstOrFail(), ['token_invalid' => null]));
        $order2 = $this->trackedOrder($store, $variant);
        $this->confirm($h, $store, $order2);
        $row2 = $this->trackingRows($tenant)->firstWhere('order_id', $order2);
        $this->assertSame(['skipped', 'no_token'], [$row2->status, $row2->skip_reason]);
        $this->assertSame(TrackingEvent::SKIPPED, $row2->status);
    }
}
