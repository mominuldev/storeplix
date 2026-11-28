<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Integrations\Mail\IntegrationAlertMail;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tracking\Jobs\DeliverTrackingEvent;
use App\Domain\Tracking\TrackingDelivery;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9D P89D-15/16/18 (S338): queued delivery with the 8.4 lease, 5 attempts inside 24 h (+1 min, +10 min, +1 h,
 * +6 h), Retry-After honoured (≤ 1 h), auth failures stop at once and flag + email once (no retry storm), ≥ 20 of 50
 * failed → delivery_failing, the minute sweep, payloads nulled when final, retention prune.
 */
#[Group('integrations')]
#[Group('tracking')]
class TrackingDeliveryTest extends TestCase
{
    use IntegrationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpIntegrations();
    }

    /** A connected Meta pixel (real CAPI driver afterwards) and one pending purchase row. @return array{0: Tenant, 1: Store, 2: array<string, string>, 3: string} */
    private function pendingPurchase(): array
    {
        Queue::fake([DeliverTrackingEvent::class]);
        [, $tenant, $store, $h] = $this->liveShop('deliver');
        [, $variant] = $this->stocked($h, $store, 50000, 50);
        $this->connect($h, $store, 'meta_pixel')->assertOk();
        $order = $this->trackedOrder($store, $variant);
        $this->confirm($h, $store, $order);
        config(['tracking.fake' => false]);
        $this->freezeSecond();

        return [$tenant, $store, $h, (string) $this->trackingRows($tenant)->first()->id];
    }

    private function attempt(Tenant $tenant, string $id): void
    {
        $this->inTenant($tenant, fn () => app(TrackingDelivery::class)->attempt($id));
    }

    private function row(string $id): object
    {
        return $this->platformTable('tracking_events')->where('id', $id)->first();
    }

    public function test_five_attempts_inside_24_hours_then_failed_and_the_lease_prevents_double_sends(): void
    {
        [$tenant, , , $id] = $this->pendingPurchase();
        Http::fake(['graph.facebook.com/*' => Http::response(['error' => ['message' => 'Service temporarily unavailable', 'code' => 2]], 503)]);
        $start = now();

        $this->attempt($tenant, $id);
        $this->assertSame(['retrying', 1, 'provider_unavailable'], [$this->row($id)->status, (int) $this->row($id)->attempts, $this->row($id)->error_code]);
        $this->assertNotNull($this->row($id)->payload);
        // Not due yet: the job and the sweep are no-ops (no second HTTP call).
        $this->attempt($tenant, $id);
        $this->artisan('tracking:dispatch-due')->assertSuccessful();
        Queue::assertPushed(DeliverTrackingEvent::class, 1); // only the original dispatch
        Http::assertSentCount(1);

        $delays = [];
        foreach ([60, 600, 3600, 21600] as $i => $delay) {
            $next = Carbon::parse($this->row($id)->next_attempt_at);
            $delays[] = (int) round(now()->diffInSeconds($next));
            $this->travelTo($next);
            // The faked queue never runs the job, so its unique lock (released by a real worker) would linger.
            Cache::lock('laravel_unique_job:'.DeliverTrackingEvent::class.':tracking-event:'.$id)->forceRelease();
            $this->artisan('tracking:dispatch-due')->assertSuccessful();
            $this->attempt($tenant, $id);
        }
        $this->assertSame([60, 600, 3600, 21600], $delays);
        $final = $this->row($id);
        $this->assertSame(['failed', 5, null, null], [$final->status, (int) $final->attempts, $final->next_attempt_at, $final->payload]);
        $this->assertLessThan(24 * 3600, $start->diffInSeconds(now()));
        Http::assertSentCount(5);
        $this->assertSame(1, (int) $this->platformTable('tracking_daily_stats')->sum('server_failed'));
        // The sweep found each due row once.
        Queue::assertPushed(DeliverTrackingEvent::class, 5);
    }

    public function test_rate_limits_honour_retry_after_capped_at_one_hour(): void
    {
        [$tenant, , , $id] = $this->pendingPurchase();
        Http::fakeSequence('graph.facebook.com/*')
            ->push(['error' => ['code' => 17, 'message' => 'User request limit reached']], 400, ['Retry-After' => '120'])
            ->push(['error' => ['message' => 'slow down']], 429, ['Retry-After' => '99999'])
            ->push(['events_received' => 1], 200);
        $this->attempt($tenant, $id);
        $this->assertSame(['retrying', 'rate_limited'], [$this->row($id)->status, $this->row($id)->error_code]);
        $this->assertSame(120, (int) round(now()->diffInSeconds(Carbon::parse($this->row($id)->next_attempt_at))));
        $this->travel(120)->seconds();
        $this->attempt($tenant, $id);
        $this->assertSame(3600, (int) round(now()->diffInSeconds(Carbon::parse($this->row($id)->next_attempt_at))));
        $this->travel(3600)->seconds();
        $this->attempt($tenant, $id);
        $this->assertSame(['delivered', 3, null], [$this->row($id)->status, (int) $this->row($id)->attempts, $this->row($id)->payload]);
    }

    #[Group('security')]
    public function test_auth_failure_stops_flags_and_emails_once_without_a_retry_storm(): void
    {
        [$tenant, $store, $h, $id] = $this->pendingPurchase();
        Http::fake(['graph.facebook.com/*' => Http::response(['error' => ['code' => 190, 'message' => 'Invalid OAuth access token '.self::META_TOKEN]], 400)]);
        $this->attempt($tenant, $id);
        $row = $this->row($id);
        $this->assertSame(['failed', 'auth', 1, null], [$row->status, $row->error_code, (int) $row->attempts, $row->next_attempt_at]);
        $integration = $this->integrationRow($tenant, $store, 'meta_pixel');
        $this->assertSame(['error', ['token_invalid']], [$integration->status, $integration->attentionReasons()]);
        Mail::assertQueued(IntegrationAlertMail::class, 1);
        $this->assertStringNotContainsString(self::META_TOKEN, (string) json_encode($row));

        // Later orders: recorded skipped (no_token); never sent, no new email.
        [, $variant] = $this->stocked($h, $store, 50000, 50);
        config(['tracking.fake' => true]);
        $order = $this->trackedOrder($store, $variant);
        $this->confirm($h, $store, $order);
        $this->assertSame(['skipped', 'no_token'], [$this->trackingRows($tenant)->last()->status, $this->trackingRows($tenant)->last()->skip_reason]);
        $this->artisan('tracking:dispatch-due')->assertSuccessful();
        Http::assertSentCount(1);
        Mail::assertQueued(IntegrationAlertMail::class, 1);
    }

    public function test_twenty_of_fifty_failed_flags_delivery_failing_and_success_clears_it(): void
    {
        [$tenant, $store, , $id] = $this->pendingPurchase();
        $integration = $this->integrationRow($tenant, $store, 'meta_pixel');
        $rows = [];
        for ($i = 0; $i < 19; $i++) {
            $rows[] = ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id, 'store_integration_id' => $integration->id,
                'provider' => 'meta_pixel', 'event_name' => 'page_view', 'provider_event_name' => 'PageView', 'event_id' => 'old-'.$i, 'channel' => 'server',
                'source' => 'browser_mirror', 'test' => false, 'status' => 'failed', 'attempts' => 5, 'error_code' => 'rejected', 'created_at' => now()->subMinutes(30), 'updated_at' => now()];
        }
        $this->platformTable('tracking_events')->insert($rows);
        Http::fake(['graph.facebook.com/*' => Http::response(['error' => ['code' => 100, 'message' => 'Invalid parameter']], 400)]);
        $this->attempt($tenant, $id);
        $integration = $this->integrationRow($tenant, $store, 'meta_pixel');
        $this->assertSame(['needs_attention', ['delivery_failing']], [$integration->status, $integration->attentionReasons()]);
        $this->assertSame(20, $integration->attention[0]['count']);

        // 31 delivered later push the failures out of the 50-row window.
        $this->platformTable('tracking_events')->where('store_integration_id', $integration->id)->where('status', 'failed')->limit(19)
            ->update(['created_at' => now()->subDays(2)]);
        $ok = [];
        for ($i = 0; $i < 31; $i++) {
            $ok[] = ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id, 'store_integration_id' => $integration->id,
                'provider' => 'meta_pixel', 'event_name' => 'page_view', 'provider_event_name' => 'PageView', 'event_id' => 'ok-'.$i, 'channel' => 'server',
                'source' => 'browser_mirror', 'test' => false, 'status' => 'delivered', 'attempts' => 1, 'created_at' => now(), 'updated_at' => now()];
        }
        $this->platformTable('tracking_events')->insert($ok);
        $this->inTenant($tenant, fn () => TrackingDelivery::recomputeFailing($this->integrationRow($tenant, $store, 'meta_pixel')));
        $this->assertSame('connected', $this->integrationRow($tenant, $store, 'meta_pixel')->status);
    }

    public function test_retention_prune(): void
    {
        [$tenant, $store, , $id] = $this->pendingPurchase();
        $integration = $this->integrationRow($tenant, $store, 'meta_pixel');
        $mk = fn (string $status, int $days, string $eid) => ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id,
            'store_integration_id' => $integration->id, 'provider' => 'meta_pixel', 'event_name' => 'purchase', 'event_id' => $eid, 'channel' => 'server', 'source' => 'order',
            'test' => false, 'status' => $status, 'attempts' => 1, 'payload' => $status === 'pending' ? null : '{"user":{"em":"x"}}',
            'created_at' => now()->subDays($days), 'updated_at' => now()->subDays($days)];
        $this->platformTable('tracking_events')->insert([$mk('delivered', 8, 'a'), $mk('skipped', 8, 'b'), $mk('delivered', 6, 'c'), $mk('failed', 8, 'd'), $mk('failed', 31, 'e')]);
        $this->platformTable('tracking_daily_stats')->insert(['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id,
            'store_integration_id' => $integration->id, 'date' => now()->subDays(91)->toDateString(), 'event_name' => 'purchase', 'browser_count' => 0, 'server_sent' => 1,
            'server_failed' => 0, 'server_skipped' => 0, 'last_at' => now()->subDays(91)]);
        $order = (string) $this->platformTable('orders')->where('store_id', $store->id)->value('id');
        $this->platformTable('order_tracking_contexts')->insert(['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id,
            'order_id' => $order, 'consent' => 'granted', 'client_ip' => '203.0.113.9', 'user_agent' => 'UA', 'created_at' => now()->subDays(91)]);

        $this->artisan('tracking:prune')->assertSuccessful();
        $this->assertSame(['c', 'd', 'purchase.'.$order], $this->platformTable('tracking_events')->orderBy('event_id')->pluck('event_id')->sort()->values()->all());
        $this->assertSame(0, $this->platformTable('tracking_events')->whereIn('status', ['delivered', 'failed', 'skipped'])->whereNotNull('payload')->count());
        $this->assertNotNull($this->row($id)->payload); // pending rows keep theirs
        $this->assertSame(0, $this->platformTable('tracking_daily_stats')->count());
        $ctx = $this->platformTable('order_tracking_contexts')->where('order_id', $order)->first();
        $this->assertSame([null, null, 'granted'], [$ctx->client_ip, $ctx->user_agent, $ctx->consent]);
        $this->platformTable('order_tracking_contexts')->update(['created_at' => now()->subDays(181)]);
        $this->artisan('tracking:prune')->assertSuccessful();
        $this->assertSame(0, $this->platformTable('order_tracking_contexts')->count());
    }

    #[Group('security')]
    public function test_job_payload_and_logs_never_carry_secrets_or_customer_data(): void
    {
        $job = new DeliverTrackingEvent(strtolower((string) Str::ulid()));
        $serialized = serialize($job->forTenant('t1'));
        $this->assertStringNotContainsString('payload', $serialized);
        $this->assertStringNotContainsString('token', strtolower($serialized));

        [$tenant, , , $id] = $this->pendingPurchase();
        $lines = [];
        Log::listen(function ($e) use (&$lines) {
            $lines[] = $e->message.' '.json_encode($e->context);
        });
        Http::fake(['graph.facebook.com/*' => function (Request $r) {
            return Http::response(['error' => ['code' => 190, 'message' => 'bad token '.self::META_TOKEN]], 401);
        }]);
        $this->attempt($tenant, $id);
        $joined = implode("\n", $lines);
        $this->assertNotSame('', $joined);
        $this->assertStringNotContainsString(self::META_TOKEN, $joined);
        $this->assertStringNotContainsString('01711000001', $joined);
    }
}
