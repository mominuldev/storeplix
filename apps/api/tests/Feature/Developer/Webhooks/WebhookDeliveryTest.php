<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\Webhooks;

use App\Domain\Billing\Models\Plan;
use App\Domain\Developer\Webhooks\Jobs\DeliverWebhook;
use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\WebhookDeliveries;
use App\Domain\Developer\Webhooks\WebhookSigner;
use App\Domain\Developer\Webhooks\WebhooksServiceProvider;
use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\CatalogFixtures;
use Tests\TestCase;

/**
 * PHASE-8-4 §4.2–§4.4, AC 1 + 2: HMAC signature (known vector, receiver verification, rotation overlap S108), the P84-9
 * retry schedule on a frozen clock, `failed` after attempt 7, resend / resend-failed, plan downgrade and disabled
 * endpoints, 72 h auto-disable (P84-11), 30-day prune, the fake driver + dev sink, S110 tenant-aware job, S112.
 */
#[Group('developer-api')]
#[Group('security')]
class WebhookDeliveryTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase, WebhookFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpWebhooks();
    }

    public function test_signature_known_vector_and_receiver_verification(): void
    {
        $secret = 'whsec_0123456789ABCDEFGHIJKLMNOPQRSTUV';
        $body = '{"id":"01JZ0000000000000000000000","type":"ping"}';
        $expected = '30bf809934e2e4fd63a7afa8814907d641d1d6a37dc450360a537e6555bfc087'; // independently computed HMAC-SHA256

        $this->assertSame($expected, WebhookSigner::v1($secret, 1764585720, $body));
        $header = WebhookSigner::header([$secret], 1764585720, $body);
        $this->assertSame("t=1764585720,v1={$expected}", $header);
        $this->assertTrue(WebhookSigner::verify($secret, $header, $body, 300, 1764585720 + 10));
        $this->assertFalse(WebhookSigner::verify($secret, $header, $body.' ', 300, 1764585720));
        $this->assertFalse(WebhookSigner::verify('whsec_other', $header, $body, 300, 1764585720));
        $this->assertFalse(WebhookSigner::verify($secret, $header, $body, 300, 1764585720 + 301)); // replay window
    }

    public function test_a_delivery_is_signed_with_the_store_secret_and_carries_the_documented_headers(): void
    {
        Http::fake(['hooks.example.com/*' => Http::response('{"received":true}', 200)]);
        [, , $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $secret = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-secret/reveal")->json('data.secret');
        $delivery = $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202)->json('data');

        Http::assertSent(function (Request $r) use ($secret, $delivery, $store) {
            $body = $r->body();
            $json = json_decode($body, true);

            return $r->url() === self::HOOK && $r->method() === 'POST'
                && $r->header('Content-Type')[0] === 'application/json'
                && $r->header('User-Agent')[0] === 'Storeplix-Webhooks/1.0'
                && $r->header('X-Storeplix-Event')[0] === 'ping'
                && $r->header('X-Storeplix-Delivery')[0] === $delivery['id']
                && WebhookSigner::verify($secret, $r->header('X-Storeplix-Signature')[0], $body)
                && substr_count($r->header('X-Storeplix-Signature')[0], 'v1=') === 1
                && $json['id'] === $delivery['event_id'] && $json['type'] === 'ping' && $json['store_id'] === $store->id
                && $json['api_version'] === '2026-12-01' && $json['data']['object'] === [];
        });
        Http::assertSentCount(1);
    }

    public function test_rotation_signs_with_both_secrets_for_24_hours_only(): void
    {
        Http::fake(['hooks.example.com/*' => Http::response('ok', 200)]);
        [, , $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $old = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-secret/reveal")->json('data.secret');
        $new = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-secret/rotate")->json('data.secret');

        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        $this->travel(23)->hours();
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        $this->travel(2)->hours(); // 25 h after the rotation
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-secret")->assertJsonPath('data.previous_expires_at', null);

        $sent = Http::recorded()->map(fn ($pair) => $pair[0])->values();
        $this->assertCount(3, $sent);
        foreach ([0, 1] as $i) {
            $sig = $sent[$i]->header('X-Storeplix-Signature')[0];
            $this->assertSame(2, substr_count($sig, 'v1='));
            $this->assertTrue(WebhookSigner::verify($new, $sig, $sent[$i]->body(), PHP_INT_MAX));
            $this->assertTrue(WebhookSigner::verify($old, $sig, $sent[$i]->body(), PHP_INT_MAX));
        }
        $sig = $sent[2]->header('X-Storeplix-Signature')[0];
        $this->assertSame(1, substr_count($sig, 'v1='));
        $this->assertTrue(WebhookSigner::verify($new, $sig, $sent[2]->body(), PHP_INT_MAX));
        $this->assertFalse(WebhookSigner::verify($old, $sig, $sent[2]->body(), PHP_INT_MAX));
    }

    public function test_retry_schedule_then_failed_after_the_seventh_attempt(): void
    {
        Http::fake(['hooks.example.com/*' => Http::response('down', 503)]);
        $this->freezeTime();
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $start = now()->copy();
        $first = $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202)->json('data');
        $this->assertSame('retrying', $first['status']);
        $this->assertSame(503, $first['response_status']);
        $this->assertSame('http_error', $first['error_code']);

        $expected = [60, 300, 1800, 7200, 21600, 43200]; // P84-9: +1 min, +5 min, +30 min, +2 h, +6 h, +12 h
        $elapsed = 0;
        foreach ($expected as $n => $delay) {
            $row = $this->deliveriesOf($tenant)->first();
            $this->assertSame($n + 1, $row->attempts);
            $this->assertSame('retrying', $row->status);
            $this->assertSame($delay, (int) $row->last_attempt_at->diffInSeconds($row->next_attempt_at));

            // Not due yet: the sweep leaves it alone.
            $this->travelTo($row->next_attempt_at->copy()->subSecond());
            $this->artisan('webhooks:dispatch-due')->assertSuccessful();
            $this->assertSame($n + 1, $this->deliveriesOf($tenant)->first()->attempts);

            $this->travelTo($row->next_attempt_at);
            $elapsed += $delay;
            $this->artisan('webhooks:dispatch-due')->assertSuccessful();
        }

        $row = $this->deliveriesOf($tenant)->first();
        $this->assertSame(7, $row->attempts);
        $this->assertSame('failed', $row->status);
        $this->assertNull($row->next_attempt_at);
        $this->assertSame(74160, $elapsed); // ≈ 20.6 h
        $this->assertEqualsWithDelta(74160, $start->diffInSeconds(now()), 1);
        Http::assertSentCount(7);

        $this->travel(1)->days();
        $this->artisan('webhooks:dispatch-due')->assertSuccessful();
        Http::assertSentCount(7); // nothing after `failed`

        $endpoint = $this->api($h, 'GET', $this->hookUrl($store))->json('data.0');
        $this->assertSame(503, $endpoint['last_status']);
        $this->assertNotNull($endpoint['failing_since']);
        $this->assertSame(0.0, (float) $endpoint['success_rate_7d']);
    }

    public function test_success_clears_failing_since_and_counts_in_the_success_rate(): void
    {
        Http::fakeSequence('hooks.example.com/*')->push('no', 500)->push('ok', 200)->push('ok', 200);
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202)->assertJsonPath('data.status', 'retrying');
        $this->assertNotNull($this->endpointRow($tenant, $id)->failing_since);
        $this->travel(61)->seconds();
        $this->artisan('webhooks:dispatch-due');
        $this->assertSame('succeeded', $this->deliveriesOf($tenant)->first()->status);
        $this->assertNull($this->endpointRow($tenant, $id)->failing_since);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202)->assertJsonPath('data.status', 'succeeded');
        $this->api($h, 'GET', $this->hookUrl($store))->assertJsonPath('data.0.success_rate_7d', 100)->assertJsonPath('data.0.last_status', 200);
    }

    public function test_resend_and_resend_failed(): void
    {
        Http::fake(['hooks.example.com/*' => Http::response('ok', 200)]);
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        $this->travel(25)->hours();
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        // Mark all three failed: one is older than 24 h.
        $this->platformQuery(WebhookDelivery::class)->where('tenant_id', $tenant->id)->update(['status' => 'failed', 'error_code' => 'http_error']);

        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-deliveries/resend-failed")->assertStatus(202)->assertJsonPath('data.count', 2);
        $this->assertCount(5, $this->deliveriesOf($tenant));
        $this->assertSame(2, $this->deliveriesOf($tenant)->where('status', 'succeeded')->count());
        // The resent ones now have a newer delivery: nothing left to resend.
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-deliveries/resend-failed")->assertStatus(202)->assertJsonPath('data.count', 0);

        $failed = $this->deliveriesOf($tenant)->first();
        $copy = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-deliveries/{$failed->id}/resend")->assertStatus(202)->json('data');
        $this->assertSame($failed->event_id, $copy['event_id']);
        $this->assertSame('succeeded', $copy['status']);
        $sent = Http::recorded()->last()[0];
        $this->assertSame($copy['id'], $sent->header('X-Storeplix-Delivery')[0]);
        $this->assertSame($failed->event_id, json_decode($sent->body(), true)['id']);
    }

    public function test_plan_downgrade_fails_pending_retries_with_plan(): void
    {
        Http::fake(['hooks.example.com/*' => Http::response('down', 503)]);
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertJsonPath('data.status', 'retrying');
        $this->planFor($tenant, Plan::FREE);
        $this->travel(2)->minutes();
        $this->artisan('webhooks:dispatch-due');
        $row = $this->deliveriesOf($tenant)->first();
        $this->assertSame('failed', $row->status);
        $this->assertSame('plan', $row->error_code);
        Http::assertSentCount(1);
    }

    public function test_disabling_or_deleting_an_endpoint_fails_its_open_deliveries(): void
    {
        Http::fake(['hooks.example.com/*' => Http::response('down', 503)]);
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertJsonPath('data.status', 'retrying');
        $this->api($h, 'PATCH', $this->hookUrl($store, "/{$id}"), ['is_active' => false])->assertOk();
        $row = $this->deliveriesOf($tenant)->first();
        $this->assertSame('failed', $row->status);
        $this->assertSame('endpoint_disabled', $row->error_code);

        $this->api($h, 'DELETE', $this->hookUrl($store, "/{$id}"))->assertNoContent();
        $this->assertCount(0, $this->deliveriesOf($tenant)); // cascade
    }

    public function test_endpoints_failing_for_72_hours_are_auto_disabled(): void
    {
        Http::fake(['hooks.example.com/*' => Http::response('down', 503), 'other.example.com/*' => Http::response('ok', 200)]);
        $this->freezeTime();
        [, $tenant, $store, $h] = $this->growthShop();
        $failing = $this->endpointId($h, $store);
        $healthy = $this->endpointId($h, $store, ['order.created'], 'https://other.example.com/ok');
        $this->api($h, 'POST', $this->hookUrl($store, "/{$failing}/test"))->assertJsonPath('data.status', 'retrying');
        $this->api($h, 'POST', $this->hookUrl($store, "/{$healthy}/test"))->assertJsonPath('data.status', 'succeeded');

        $this->travel(72)->hours();
        $this->travel(-1)->minutes();
        $this->artisan('webhooks:auto-disable')->assertSuccessful();
        $this->assertTrue($this->endpointRow($tenant, $failing)->is_active);

        $this->travel(2)->minutes();
        $this->artisan('webhooks:auto-disable')->assertSuccessful();
        $row = $this->endpointRow($tenant, $failing);
        $this->assertFalse($row->is_active);
        $this->assertSame('failing', $row->disabled_reason);
        $this->assertTrue($this->endpointRow($tenant, $healthy)->is_active);
        $this->assertSame(0, $this->deliveriesOf($tenant)->whereIn('status', ['pending', 'retrying'])->count());
        $log = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'webhook_endpoint.auto_disabled')->sole();
        $this->assertSame('system', $log->actor_type);
        $this->assertSame($failing, $log->subject_id);

        // Manual re-enable clears the failing state.
        $this->api($h, 'PATCH', $this->hookUrl($store, "/{$failing}"), ['is_active' => true])->assertOk()
            ->assertJsonPath('data.disabled_reason', null)->assertJsonPath('data.failing_since', null);
    }

    public function test_deliveries_older_than_30_days_are_pruned(): void
    {
        Http::fake(['hooks.example.com/*' => Http::response('ok', 200)]);
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        $this->travel(29)->days();
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        $this->travel(2)->days();
        $this->artisan('webhooks:prune-deliveries')->assertSuccessful();
        $left = $this->deliveriesOf($tenant);
        $this->assertCount(1, $left);
        $this->assertTrue($left->first()->created_at->greaterThan(now()->subDays(30)));
    }

    public function test_fake_driver_records_the_signed_body_in_the_dev_sink_and_answers_by_suffix(): void
    {
        Http::fake(); // nothing may go out
        config(['webhooks_out.fake' => true]);
        $this->dns->map = []; // no DNS: the fake never resolves names
        [, $tenant, $store, $h] = $this->growthShop();
        $ok = $this->endpointId($h, $store, ['order.created'], 'https://example.com/storeplix-e2e/a');
        $fail = $this->endpointId($h, $store, ['order.created'], 'https://example.com/storeplix-e2e/b/fail-503');
        $slow = $this->endpointId($h, $store, ['order.created'], 'https://example.com/storeplix-e2e/c/timeout');
        $secret = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-secret/reveal")->json('data.secret');

        $this->api($h, 'POST', $this->hookUrl($store, "/{$ok}/test"))->assertJsonPath('data.status', 'succeeded')->assertJsonPath('data.response_status', 200);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$fail}/test"))->assertJsonPath('data.status', 'retrying')->assertJsonPath('data.response_status', 503);
        $this->api($h, 'POST', $this->hookUrl($store, "/{$slow}/test"))->assertJsonPath('data.status', 'retrying')->assertJsonPath('data.error_code', 'timeout');
        Http::assertNothingSent();

        $sink = $this->api($h, 'GET', '/api/v1/dev/webhook-sink')->assertOk()->json('data');
        $this->assertCount(3, $sink);
        $first = end($sink);
        $this->assertSame('https://example.com/storeplix-e2e/a', $first['url']);
        $this->assertTrue(WebhookSigner::verify($secret, $first['headers']['X-Storeplix-Signature'], $first['raw_body']));
        $this->assertSame('ping', json_decode($first['raw_body'], true)['type']);

        $endpoint = collect($this->api($h, 'GET', $this->hookUrl($store))->json('data'))->firstWhere('id', $fail);
        $this->assertSame(503, $endpoint['last_status']);
        $this->assertNotNull($endpoint['failing_since']);

        // Other tenants' sinks are separate; staff can't read it; off without the fake.
        [, , , $hB] = $this->growthShop('other');
        $this->api($hB, 'GET', '/api/v1/dev/webhook-sink')->assertOk()->assertJsonCount(0, 'data');
        config(['webhooks_out.fake' => false]);
        $this->api($h, 'GET', '/api/v1/dev/webhook-sink')->assertNotFound();
    }

    public function test_fake_and_allow_http_refuse_to_boot_in_production(): void
    {
        foreach (['webhooks_out.fake' => 'WEBHOOKS_OUT_FAKE', 'webhooks_out.allow_http' => 'WEBHOOKS_OUT_ALLOW_HTTP'] as $key => $env) {
            config(['webhooks_out.fake' => false, 'webhooks_out.allow_http' => false, $key => true]);
            $this->app['env'] = 'production';
            try {
                WebhooksServiceProvider::assertSafeConfiguration($this->app);
                $this->fail("{$env}=true booted in production");
            } catch (RuntimeException $e) {
                $this->assertStringContainsString($env, $e->getMessage());
            } finally {
                $this->app['env'] = 'testing';
            }
        }
        config(['webhooks_out.fake' => true, 'webhooks_out.allow_http' => true]);
        WebhooksServiceProvider::assertSafeConfiguration($this->app); // fine outside production
        config(['webhooks_out.fake' => false, 'webhooks_out.allow_http' => false]);
        $this->app['env'] = 'production';
        try {
            WebhooksServiceProvider::assertSafeConfiguration($this->app);
        } finally {
            $this->app['env'] = 'testing';
        }
        $this->assertTrue(true);
    }

    public function test_the_delivery_job_runs_only_inside_the_deliverys_tenant(): void
    {
        Http::fake(['hooks.example.com/*' => Http::response('down', 503)]);
        [, $tenantA, $storeA, $hA] = $this->growthShop('alpha');
        [, $tenantB] = $this->growthShop('beta');
        $id = $this->endpointId($hA, $storeA);
        $this->api($hA, 'POST', $this->hookUrl($storeA, "/{$id}/test"))->assertJsonPath('data.status', 'retrying');
        $delivery = $this->deliveriesOf($tenantA)->first();
        $this->travel(2)->minutes();

        try {
            dispatch_sync(new DeliverWebhook($delivery->id));
            $this->fail('a delivery job without a tenant ran');
        } catch (MissingTenantContextException) {
        }
        dispatch_sync((new DeliverWebhook($delivery->id))->forTenant($tenantB->id)); // B can't see A's row: no-op
        $this->assertSame(1, $this->deliveriesOf($tenantA)->first()->attempts);
        dispatch_sync((new DeliverWebhook($delivery->id))->forTenant($tenantA->id));
        $this->assertSame(2, $this->deliveriesOf($tenantA)->first()->attempts);
        $this->assertSame('webhooks-out', (new DeliverWebhook('x'))->queue);
    }

    public function test_response_excerpt_is_one_kilobyte_without_control_characters(): void
    {
        $this->assertSame('ab', WebhookDeliveries::excerpt("a\x00\x07b"));
        $this->assertSame(1024, strlen((string) WebhookDeliveries::excerpt(str_repeat('x', 5000))));
        $this->assertNull(WebhookDeliveries::excerpt(''));
    }
}
