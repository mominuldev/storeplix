<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\Webhooks;

use App\Domain\Billing\Models\Plan;
use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\Models\WebhookEndpoint;
use App\Domain\Developer\Webhooks\Models\WebhookSecret;
use App\Domain\Developer\Webhooks\WebhookSigner;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/**
 * PHASE-8-4 §6.1 webhook rows: endpoints CRUD + validation + limit + plan (402) + authz (staff 403, custom role) +
 * cross-tenant/store 404; signing secret show/reveal/rotate (S109 encryption at rest, audit); event catalogue;
 * deliveries list/detail/resend; store isolation of the three tables (S110).
 */
#[Group('developer-api')]
#[Group('security')]
class WebhookEndpointsApiTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase, StorefrontContent, WebhookFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpWebhooks();
        Http::fake(['hooks.example.com/*' => Http::response('ok', 200), 'other.example.com/*' => Http::response('ok', 200)]);
    }

    public function test_owner_creates_lists_updates_and_deletes_an_endpoint(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();

        $created = $this->api($h, 'POST', $this->hookUrl($store), [
            'url' => self::HOOK, 'events' => ['stock.low', 'order.created', 'order.paid'], 'description' => '  Accounting  ',
        ])->assertCreated()->json('data');
        $this->assertSame(['order.created', 'order.paid', 'stock.low'], $created['events']); // catalogue order
        $this->assertSame('Accounting', $created['description']);
        $this->assertTrue($created['is_active']);
        $this->assertNull($created['success_rate_7d']);
        foreach (['id', 'url', 'description', 'events', 'is_active', 'disabled_reason', 'failing_since', 'last_delivery_at', 'last_status', 'success_rate_7d', 'created_at', 'updated_at'] as $key) {
            $this->assertArrayHasKey($key, $created);
        }

        $list = $this->api($h, 'GET', $this->hookUrl($store))->assertOk();
        $list->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $created['id']);
        $this->assertArrayNotHasKey('meta', $list->json());

        $this->api($h, 'PATCH', $this->hookUrl($store, "/{$created['id']}"), ['events' => ['customer.created'], 'url' => 'https://other.example.com/hook', 'description' => ''])
            ->assertOk()->assertJsonPath('data.events', ['customer.created'])->assertJsonPath('data.url', 'https://other.example.com/hook')->assertJsonPath('data.description', null);
        $this->api($h, 'PATCH', $this->hookUrl($store, "/{$created['id']}"), ['is_active' => false])
            ->assertOk()->assertJsonPath('data.is_active', false)->assertJsonPath('data.disabled_reason', 'manual');
        $this->api($h, 'PATCH', $this->hookUrl($store, "/{$created['id']}"), ['is_active' => true])
            ->assertOk()->assertJsonPath('data.disabled_reason', null);

        $this->api($h, 'DELETE', $this->hookUrl($store, "/{$created['id']}"))->assertNoContent();
        $this->api($h, 'GET', $this->hookUrl($store))->assertOk()->assertJsonCount(0, 'data');

        $actions = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', 'webhook_endpoint.%')->pluck('action')->countBy()->all();
        $this->assertEquals(['webhook_endpoint.created' => 1, 'webhook_endpoint.updated' => 3, 'webhook_endpoint.deleted' => 1], $actions);
    }

    public function test_validation(): void
    {
        [, , $store, $h] = $this->growthShop();
        $this->api($h, 'POST', $this->hookUrl($store), [])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonValidationErrors(['url', 'events'], 'error.details');
        $this->api($h, 'POST', $this->hookUrl($store), ['url' => self::HOOK, 'events' => ['ping']])->assertStatus(422)->assertJsonValidationErrors(['events.0'], 'error.details');
        $this->api($h, 'POST', $this->hookUrl($store), ['url' => self::HOOK, 'events' => ['order.created', 'order.created']])->assertStatus(422);
        $this->api($h, 'POST', $this->hookUrl($store), ['url' => self::HOOK, 'events' => []])->assertStatus(422);
        $this->api($h, 'POST', $this->hookUrl($store), ['url' => self::HOOK, 'events' => ['order.created'], 'description' => str_repeat('x', 121)])->assertStatus(422);
        $this->api($h, 'POST', $this->hookUrl($store), ['url' => 'not a url', 'events' => ['order.created']])->assertStatus(422)->assertJsonPath('error.code', 'webhook_url_not_allowed');
        $id = $this->endpointId($h, $store);
        $this->api($h, 'PATCH', $this->hookUrl($store, "/{$id}"), ['is_active' => 'yes'])->assertStatus(422);
        $this->api($h, 'PATCH', $this->hookUrl($store, "/{$id}"), ['url' => 'http://hooks.example.com/x'])->assertStatus(422)->assertJsonPath('error.code', 'webhook_url_not_allowed');
    }

    public function test_at_most_five_endpoints_per_store(): void
    {
        [, , $store, $h] = $this->growthShop();
        for ($i = 0; $i < 5; $i++) {
            $this->addEndpoint($h, $store, ['order.created'], self::HOOK."/{$i}")->assertCreated();
        }
        $this->addEndpoint($h, $store, ['order.created'], self::HOOK.'/6')->assertStatus(422)->assertJsonPath('error.code', 'limit_reached');
    }

    public function test_writes_need_the_api_webhooks_feature_reads_do_not(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $this->planFor($tenant, Plan::FREE);

        foreach ([
            ['POST', $this->hookUrl($store), ['url' => self::HOOK, 'events' => ['order.created']]],
            ['PATCH', $this->hookUrl($store, "/{$id}"), ['description' => 'x']],
            ['DELETE', $this->hookUrl($store, "/{$id}"), []],
            ['POST', $this->hookUrl($store, "/{$id}/test"), []],
            ['POST', "/api/v1/stores/{$store->id}/webhook-secret/rotate", []],
            ['POST', "/api/v1/stores/{$store->id}/webhook-deliveries/resend-failed", []],
        ] as [$method, $url, $body]) {
            $this->api($h, $method, $url, $body)->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan')
                ->assertJsonPath('error.details.upgrade_plan.0', 'growth');
        }
        // Invalid body on Free: still 402 first (plan before validation).
        $this->api($h, 'POST', $this->hookUrl($store), [])->assertStatus(402);

        $this->api($h, 'GET', $this->hookUrl($store))->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-secret")->assertOk();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-secret/reveal")->assertOk();
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-deliveries")->assertOk();
        $this->api($h, 'GET', '/api/v1/webhook-event-types')->assertOk();
        $this->assertSame(1, $this->platformQuery(WebhookEndpoint::class)->where('tenant_id', $tenant->id)->count()); // nothing deleted
    }

    public function test_staff_cannot_reach_any_webhook_route_admin_and_custom_role_with_the_permission_can(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        [, $staff] = $this->memberAs($tenant, TenantUser::ROLE_STAFF);
        foreach ($this->routes($store, $id) as [$method, $url]) {
            $this->api($staff, $method, $url)->assertForbidden();
        }

        [, $admin] = $this->memberAs($tenant, TenantUser::ROLE_ADMIN);
        $this->api($admin, 'GET', $this->hookUrl($store))->assertOk();
        $this->api($admin, 'POST', "/api/v1/stores/{$store->id}/webhook-secret/reveal")->assertOk();

        $role = $this->customRole($h, 'Integrator', ['developers.manage']);
        [, $custom] = $this->memberWithRole($tenant, $role);
        $this->api($custom, 'GET', $this->hookUrl($store))->assertOk();
        $this->addEndpoint($custom, $store, ['order.paid'], self::HOOK.'/custom')->assertCreated();
    }

    public function test_other_tenants_store_and_ids_are_404(): void
    {
        [, , $storeA, $hA] = $this->growthShop('alpha');
        [, , $storeB, $hB] = $this->growthShop('beta');
        $idB = $this->endpointId($hB, $storeB);
        $this->api($hB, 'POST', $this->hookUrl($storeB, "/{$idB}/test"))->assertStatus(202);
        $deliveryB = $this->api($hB, 'GET', "/api/v1/stores/{$storeB->id}/webhook-deliveries")->json('data.0.id');

        $this->assertTenantIsolation($hA, [
            ...$this->routes($storeB, $idB),
            ['GET', "/api/v1/stores/{$storeB->id}/webhook-deliveries/{$deliveryB}"],
            ['POST', "/api/v1/stores/{$storeB->id}/webhook-deliveries/{$deliveryB}/resend"],
        ]);
        // B's ids under A's own store → 404 as well.
        $this->assertTenantIsolation($hA, [
            ['PATCH', $this->hookUrl($storeA, "/{$idB}"), ['description' => 'x']],
            ['DELETE', $this->hookUrl($storeA, "/{$idB}")],
            ['POST', $this->hookUrl($storeA, "/{$idB}/test")],
            ['GET', "/api/v1/stores/{$storeA->id}/webhook-deliveries/{$deliveryB}"],
            ['POST', "/api/v1/stores/{$storeA->id}/webhook-deliveries/{$deliveryB}/resend"],
        ]);
        $this->api($hA, 'GET', "/api/v1/stores/{$storeA->id}/webhook-deliveries?filter[endpoint_id]={$idB}")->assertOk()->assertJsonCount(0, 'data');
    }

    public function test_store_isolation_of_the_webhook_tables(): void
    {
        [, $tenantA, $storeA, $hA] = $this->growthShop('alpha');
        [, , $storeB, $hB] = $this->growthShop('beta');
        foreach ([[$hA, $storeA], [$hB, $storeB]] as [$h, $store]) {
            $id = $this->endpointId($h, $store);
            $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        }
        foreach ([WebhookEndpoint::class, WebhookSecret::class, WebhookDelivery::class] as $model) {
            $this->assertStoreIsolation($model, $tenantA, $storeA, $storeB);
        }
    }

    public function test_signing_secret_is_lazy_encrypted_at_rest_revealable_and_rotatable(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $shown = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-secret")->assertOk()->json('data');
        $this->assertMatchesRegularExpression('/^whsec_••••[0-9A-Za-z]{4}$/', $shown['masked']);
        $this->assertNull($shown['rotated_at']);
        $this->assertNull($shown['previous_expires_at']);
        $this->assertArrayNotHasKey('secret', $shown);

        $secret = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-secret/reveal")->assertOk()->json('data.secret');
        $this->assertMatchesRegularExpression('/^whsec_[0-9A-Za-z]{32}$/', $secret);
        $this->assertSame(substr($secret, -4), $shown['last_four']);

        // S109: never plaintext in the database.
        $row = (array) $this->platformTable('webhook_secrets')->where('tenant_id', $tenant->id)->first();
        foreach ($row as $value) {
            $this->assertStringNotContainsString($secret, (string) $value);
            $this->assertStringNotContainsString(substr($secret, 6), (string) $value);
        }

        $rotated = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-secret/rotate")->assertOk()->json('data');
        $this->assertNotSame($secret, $rotated['secret']);
        $this->assertNotNull($rotated['rotated_at']);
        $this->assertNotNull($rotated['previous_expires_at']);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-secret/reveal")->assertJsonPath('data.secret', $rotated['secret']);
        $this->assertSame(1, $this->platformTable('webhook_secrets')->where('tenant_id', $tenant->id)->count());

        $actions = $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', 'webhook_secret.%')->pluck('action')->countBy()->all();
        $this->assertEquals(['webhook_secret.revealed' => 2, 'webhook_secret.rotated' => 1], $actions);
        foreach ($this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->get() as $log) {
            $this->assertStringNotContainsString($secret, (string) json_encode($log->meta));
        }
    }

    public function test_reveal_is_throttled_to_ten_per_minute(): void
    {
        $route = app('router')->getRoutes()->getByName('stores.webhook-secret.reveal');
        $this->assertContains('throttle:10,1,stores.webhook-secret.reveal', $route->gatherMiddleware());
    }

    public function test_event_type_catalogue(): void
    {
        [, , , $h] = $this->growthShop();
        $data = $this->api($h, 'GET', '/api/v1/webhook-event-types')->assertOk()->json('data');
        $this->assertSame(['order.created', 'order.confirmed', 'order.cancelled', 'order.paid', 'shipment.updated', 'shipment.delivered',
            'return.received', 'product.updated', 'stock.low', 'customer.created'], array_column($data, 'key'));
        foreach ($data as $row) {
            $this->assertNotSame('', $row['label']);
            $this->assertNotSame('', $row['description']);
        }
    }

    public function test_test_event_list_detail_and_resend(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $queued = $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202)->json('data');
        $this->assertSame('ping', $queued['event_type']);
        $this->assertSame('succeeded', $queued['status']); // sync queue in tests
        $this->assertSame(1, $queued['attempts']);

        $list = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-deliveries")->assertOk();
        $list->assertJsonCount(1, 'data')->assertJsonPath('meta.per_page', 25);
        $this->assertArrayNotHasKey('payload', $list->json('data.0'));
        foreach (['id', 'endpoint_id', 'event_id', 'event_type', 'subject_label', 'status', 'attempts', 'next_attempt_at', 'last_attempt_at', 'response_status', 'error_code', 'duration_ms', 'created_at'] as $key) {
            $this->assertArrayHasKey($key, $list->json('data.0'));
        }

        $detail = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-deliveries/{$queued['id']}")->assertOk()->json('data');
        $this->assertSame('ping', $detail['payload']['type']);
        $this->assertSame('2026-12-01', $detail['payload']['api_version']);
        $this->assertSame($store->id, $detail['payload']['store_id']);
        $this->assertSame([], $detail['payload']['data']['object']);
        $this->assertSame($queued['id'], $detail['request_headers']['X-Storeplix-Delivery']);
        $this->assertDoesNotMatchRegularExpression('/v1=[0-9a-f]{64}/', $detail['request_headers'][WebhookSigner::HEADER]);
        $this->assertSame('ok', $detail['response_body_excerpt']);

        $resent = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/webhook-deliveries/{$queued['id']}/resend")->assertStatus(202)->json('data');
        $this->assertNotSame($queued['id'], $resent['id']);
        $this->assertSame($queued['event_id'], $resent['event_id']);
        $this->assertCount(2, $this->deliveriesOf($tenant));
        $this->assertSame(0, $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', '%resen%')->count());

        // filters
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-deliveries?filter[status]=failed")->assertOk()->assertJsonCount(0, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-deliveries?filter[event_type]=ping&filter[endpoint_id]={$id}")->assertOk()->assertJsonCount(2, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-deliveries?filter[status]=nope")->assertStatus(422);
    }

    public function test_test_event_on_a_disabled_endpoint_is_409(): void
    {
        [, , $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        $this->api($h, 'PATCH', $this->hookUrl($store, "/{$id}"), ['is_active' => false])->assertOk();
        $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(409)->assertJsonPath('error.code', 'webhook_endpoint_disabled');
    }

    public function test_deliveries_are_cursor_paginated_newest_first(): void
    {
        [, , $store, $h] = $this->growthShop();
        $id = $this->endpointId($h, $store);
        for ($i = 0; $i < 27; $i++) {
            $this->travel(1)->seconds();
            $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        }
        $first = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-deliveries")->assertOk();
        $first->assertJsonCount(25, 'data');
        $cursor = $first->json('meta.next_cursor');
        $this->assertNotNull($cursor);
        $this->assertGreaterThan($first->json('data.1.created_at'), $first->json('data.0.created_at'));
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/webhook-deliveries?cursor=".urlencode($cursor))->assertOk()->assertJsonCount(2, 'data');
    }

    /** @return list<array{0: string, 1: string}> */
    private function routes($store, string $id): array
    {
        return [
            ['GET', $this->hookUrl($store)],
            ['POST', $this->hookUrl($store)],
            ['PATCH', $this->hookUrl($store, "/{$id}")],
            ['DELETE', $this->hookUrl($store, "/{$id}")],
            ['POST', $this->hookUrl($store, "/{$id}/test")],
            ['GET', "/api/v1/stores/{$store->id}/webhook-secret"],
            ['POST', "/api/v1/stores/{$store->id}/webhook-secret/reveal"],
            ['POST', "/api/v1/stores/{$store->id}/webhook-secret/rotate"],
            ['GET', "/api/v1/stores/{$store->id}/webhook-deliveries"],
            ['POST', "/api/v1/stores/{$store->id}/webhook-deliveries/resend-failed"],
        ];
    }
}
