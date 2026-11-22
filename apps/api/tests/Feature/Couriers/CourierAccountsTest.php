<?php

declare(strict_types=1);

namespace Tests\Feature\Couriers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Couriers\AreaMapper;
use App\Domain\Couriers\CouriersServiceProvider;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Database\Seeders\PlanSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\CommerceFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/**
 * PHASE-5B §4.6 / §13 "Couriers": connect/verify, plan limit, settings, test, webhook secret, disconnect, areas,
 * pickup stores; S26 (credentials never returned/logged), S27, S38 (staff 403 on writes), foreign store 404, S39.
 */
#[Group('couriers')]
class CourierAccountsTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, StorefrontContent;

    private const STEADFAST = ['api_key' => 'sf-api-key-77aa', 'secret_key' => 'sf-secret-key-value'];

    private const PATHAO = ['client_id' => 'pathao-client-1d2e', 'client_secret' => 'pathao-client-secret', 'username' => 'merchant@example.test', 'password' => 'Pathao-Pass-1'];

    private const KEYS = ['provider', 'status', 'mode', 'credentials_hint', 'is_default', 'settings', 'webhook_url', 'webhook_secret_hint', 'capabilities',
        'last_synced_at', 'last_webhook_at', 'last_error_code', 'connected_by', 'connected_at', 'revision'];

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        config(['couriers.fake' => false, 'payments.public_api_url' => 'https://api.storeplix.test']);
        Http::preventStrayRequests();
    }

    private function url(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/couriers".$suffix;
    }

    private function fixture(string $name): array
    {
        return json_decode((string) file_get_contents(base_path("tests/Fixtures/couriers/{$name}.json")), true, 512, JSON_THROW_ON_ERROR);
    }

    private function fakeSteadfast(): void
    {
        Http::fake(['portal.packzy.com/api/v1/get_balance' => Http::response($this->fixture('steadfast/get_balance'))]);
    }

    private function connect(array $h, Store $store, string $provider = 'steadfast', ?array $credentials = null, array $extra = [])
    {
        return $this->api($h, 'PUT', $this->url($store, "/{$provider}"), ['mode' => $provider === 'steadfast' ? 'live' : 'sandbox', 'credentials' => $credentials ?? ($provider === 'pathao' ? self::PATHAO : self::STEADFAST)] + $extra);
    }

    private function pickup(Tenant $tenant, Store $store): string
    {
        return (string) $this->inTenant($tenant, function () use ($store) {
            $id = PickupLocation::query()->where('store_id', $store->id)->value('id');
            if ($id === null) {
                $l = new PickupLocation;
                $l->forceFill(['store_id' => $store->id, 'name' => 'Warehouse', 'district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi', 'address_line' => 'House 1', 'is_default' => true])->save();
                $id = $l->id;
            }

            return $id;
        });
    }

    public function test_list_shows_all_three_couriers_and_absent_ones_as_not_connected(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $data = $this->api($h, 'GET', $this->url($store))->assertOk()->json('data');
        $this->assertSame(['steadfast', 'pathao', 'redx'], array_column($data, 'provider'));
        foreach ($data as $row) {
            $this->assertSame(self::KEYS, array_keys($row));
            $this->assertSame(['not_connected', null, null, false, null, 0], [$row['status'], $row['mode'], $row['credentials_hint'], $row['is_default'], $row['webhook_url'], $row['revision']]);
            $this->assertSame(['pickup_location_id' => null, 'parcel_description' => '{items}', 'default_weight_grams' => 500], array_slice($row['settings'], 0, 3));
        }
        $this->assertSame(48, $data[1]['settings']['delivery_type']);
        $this->assertArrayHasKey('redx_pickup_store_id', $data[2]['settings']);
        $this->assertSame(['bulk', 'webhook'], $data[0]['capabilities']);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($staff, 'GET', $this->url($store))->assertOk();
    }

    public function test_connect_steadfast_checks_balance_issues_a_secret_once_and_never_returns_or_logs_secrets(): void
    {
        $this->fakeSteadfast();
        $logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e) use (&$logged) {
            $logged[] = $e->message.' '.json_encode($e->context);
        });
        [$user, $tenant, $store, $h] = $this->liveShop();
        $pickup = $this->pickup($tenant, $store);

        $res = $this->connect($h, $store, extra: ['settings' => ['pickup_location_id' => $pickup, 'parcel_description' => '{order_no}: {items}', 'default_weight_grams' => 700]])->assertOk();
        $this->assertSame(self::KEYS, array_keys($res->json('data')));
        $secret = $res->json('meta.webhook_secret');
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9]{40}$/', $secret);
        $res->assertJsonPath('data.status', 'connected')->assertJsonPath('data.mode', 'live')->assertJsonPath('data.credentials_hint', '••••77aa')
            ->assertJsonPath('data.is_default', true)->assertJsonPath('data.revision', 1)->assertJsonPath('data.connected_by.id', $user->id)
            ->assertJsonPath('data.webhook_secret_hint', '••••'.substr($secret, -4))
            ->assertJsonPath('data.settings', ['pickup_location_id' => $pickup, 'parcel_description' => '{order_no}: {items}', 'default_weight_grams' => 700]);
        $account = $this->inTenant($tenant, fn () => CourierAccount::query()->firstOrFail());
        $this->assertSame("https://api.storeplix.test/api/v1/webhooks/steadfast/{$account->route_key}", $res->json('data.webhook_url'));
        $this->assertNotNull($res->json('data.connected_at'));
        Http::assertSent(fn ($r) => $r->url() === 'https://portal.packzy.com/api/v1/get_balance' && $r->hasHeader('Api-Key', self::STEADFAST['api_key']));

        // S26: ciphertext columns, hash of the secret, nothing in the response, the logs or the audit row.
        $row = (array) $this->platformTable('courier_accounts')->first();
        foreach ([...array_values(self::STEADFAST), $secret] as $value) {
            $this->assertStringNotContainsString($value, json_encode($row));
            $this->assertStringNotContainsString($value, implode("\n", $logged));
        }
        foreach (self::STEADFAST as $value) {
            $this->assertStringNotContainsString($value, $res->getContent());
        }
        $this->assertSame(hash('sha256', $secret), $row['webhook_secret_hash']);
        $this->assertSame(self::STEADFAST, $account->credentials);
        $this->assertSame($secret, $account->webhookSecret());
        $this->assertTrue($account->webhookSecretMatches($secret));
        $this->assertArrayNotHasKey('credentials', $account->toArray());
        $this->assertArrayNotHasKey('webhook_secret_encrypted', $account->toArray());
        $audit = $this->inTenant($tenant, fn () => $this->platformQuery(AuditLog::class)->where('action', 'integration.connected')->firstOrFail());
        $this->assertSame(['kind' => 'courier', 'provider' => 'steadfast', 'mode' => 'live', 'replaced' => false], $audit->meta);

        // Reconnect (new credentials): the secret stays, nothing is shown again; the list never shows secrets.
        $again = $this->connect($h, $store, credentials: ['api_key' => 'sf-api-key-new1', 'secret_key' => 'other'])->assertOk();
        $again->assertJsonPath('meta.webhook_secret', null)->assertJsonPath('data.revision', 2)->assertJsonPath('data.credentials_hint', '••••new1');
        $this->assertTrue($this->inTenant($tenant, fn () => CourierAccount::query()->firstOrFail())->webhookSecretMatches($secret));
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $list = $this->api($staff, 'GET', $this->url($store))->assertOk()->getContent();
        $this->assertStringNotContainsString($secret, $list);
        $this->assertStringNotContainsString('sf-api-key-new1', $list);
    }

    public function test_connect_rejections_invalid_credentials_unavailable_validation_and_unknown_provider(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        Http::fake(['portal.packzy.com/*' => Http::sequence()
            ->push(['message' => 'Unauthorized'], 401)
            ->pushResponse(fn () => throw new ConnectionException('timeout'))]);
        $this->connect($h, $store)->assertStatus(422)->assertJsonPath('error.code', 'credentials_invalid');
        Http::fake(['portal.packzy.com/*' => fn () => throw new ConnectionException('timeout')]);
        $this->connect($h, $store)->assertStatus(502)->assertJsonPath('error.code', 'provider_unavailable');
        $this->assertSame(0, $this->platformTable('courier_accounts')->count());

        // Steadfast has no sandbox (its only host is live): `sandbox` would book real parcels, so it's refused.
        $this->api($h, 'PUT', $this->url($store, '/steadfast'), ['mode' => 'sandbox', 'credentials' => self::STEADFAST])
            ->assertStatus(422)->assertJsonPath('error.details.mode.0', 'Steadfast has no sandbox. Connect with your live API keys.');
        $this->connect($h, $store, credentials: ['api_key' => 'x'])->assertStatus(422)->assertJsonValidationErrors(['credentials.secret_key'], 'error.details');
        $this->connect($h, $store, credentials: self::STEADFAST + ['base_url' => 'https://evil.test'])->assertStatus(422)->assertJsonValidationErrors(['credentials'], 'error.details');
        $this->connect($h, $store, 'pathao', ['username' => 'not-an-email'] + self::PATHAO)->assertStatus(422)->assertJsonValidationErrors(['credentials.username'], 'error.details');
        $this->api($h, 'PUT', $this->url($store, '/steadfast'), ['mode' => 'production', 'credentials' => self::STEADFAST])->assertStatus(422)->assertJsonValidationErrors(['mode'], 'error.details');
        $this->connect($h, $store, extra: ['settings' => ['parcel_description' => '{items} {phone}']])->assertStatus(422)->assertJsonValidationErrors(['settings.parcel_description'], 'error.details');
        $this->connect($h, $store, extra: ['settings' => ['redx_pickup_store_id' => '1']])->assertStatus(422)->assertJsonValidationErrors(['settings'], 'error.details');
        $this->api($h, 'PUT', $this->url($store, '/sundarban'), ['mode' => 'sandbox', 'credentials' => []])->assertNotFound();
        $this->api($h, 'GET', $this->url($store, '/bkash/areas?level=city'))->assertNotFound();

        // Fake driver: credential field named in details.
        config(['couriers.fake' => true]);
        $this->connect($h, $store, 'pathao', ['client_id' => 'invalid-client'] + self::PATHAO)->assertStatus(422)
            ->assertJsonPath('error.code', 'credentials_invalid')->assertJsonPath('error.details', ['credentials.client_id' => ['Rejected by the courier.']]);
    }

    public function test_plan_limit_courier_connections_on_free(): void
    {
        $this->seed(PlanSeeder::class);
        config(['couriers.fake' => true]);
        [, $tenant, $store, $h] = $this->liveShop();
        $this->inTenant($tenant, fn () => Subscription::query()->update(['plan_id' => Plan::query()->where('code', Plan::FREE)->value('id'), 'status' => Subscription::ACTIVE]));
        FeatureGate::forget($tenant->id);

        $this->connect($h, $store)->assertOk();
        $this->connect($h, $store, credentials: ['api_key' => 'replace-key', 'secret_key' => 'x'])->assertOk(); // replacing isn't a new connection
        $this->connect($h, $store, 'pathao')->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached')
            ->assertJsonPath('error.message', 'Your plan allows 1 courier connections.');
        $this->api($h, 'DELETE', $this->url($store, '/steadfast'))->assertNoContent();
        $this->connect($h, $store, 'pathao')->assertOk();
    }

    public function test_patch_settings_default_revision_and_foreign_pickup_location(): void
    {
        config(['couriers.fake' => true]);
        [, $tenant, $store, $h] = $this->liveShop();
        [, $tenantB, $storeB] = $this->liveShop('other');
        $this->connect($h, $store)->assertOk();
        $pathao = $this->connect($h, $store, 'pathao')->assertOk();
        $pathao->assertJsonPath('data.is_default', false);
        $pickup = $this->pickup($tenant, $store);
        $foreign = $this->pickup($tenantB, $storeB);

        $this->api($h, 'PATCH', $this->url($store, '/pathao'), ['revision' => 1, 'settings' => ['pickup_location_id' => $foreign]])
            ->assertStatus(422)->assertJsonValidationErrors(['settings.pickup_location_id'], 'error.details');
        $this->api($h, 'PATCH', $this->url($store, '/pathao'), ['revision' => 1, 'settings' => ['default_weight_grams' => 400]])
            ->assertStatus(422)->assertJsonValidationErrors(['settings.default_weight_grams'], 'error.details');
        $this->api($h, 'PATCH', $this->url($store, '/steadfast'), ['revision' => 1, 'settings' => ['default_weight_grams' => 20001]])
            ->assertStatus(422)->assertJsonValidationErrors(['settings.default_weight_grams'], 'error.details');
        $this->api($h, 'PATCH', $this->url($store, '/pathao'), ['revision' => 1, 'settings' => ['delivery_type' => 24]])
            ->assertStatus(422)->assertJsonValidationErrors(['settings.delivery_type'], 'error.details');

        $res = $this->api($h, 'PATCH', $this->url($store, '/pathao'), ['revision' => 1, 'is_default' => true, 'settings' => [
            'pickup_location_id' => $pickup, 'parcel_description' => 'Order {order_no}', 'default_weight_grams' => 1000, 'pathao_store_id' => '1234', 'delivery_type' => 12,
        ]])->assertOk();
        $res->assertJsonPath('data.revision', 2)->assertJsonPath('data.is_default', true)
            ->assertJsonPath('data.settings', ['pickup_location_id' => $pickup, 'parcel_description' => 'Order {order_no}', 'default_weight_grams' => 1000, 'pathao_store_id' => '1234', 'delivery_type' => 12]);
        $list = collect($this->api($h, 'GET', $this->url($store))->json('data'))->keyBy('provider');
        $this->assertFalse($list['steadfast']['is_default']);
        $this->assertSame(2, $list['steadfast']['revision']);
        $this->api($h, 'PATCH', $this->url($store, '/pathao'), ['revision' => 1, 'settings' => ['default_weight_grams' => 900]])
            ->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'PATCH', $this->url($store, '/redx'), ['revision' => 1])->assertNotFound();
        $audit = $this->inTenant($tenant, fn () => $this->platformQuery(AuditLog::class)->where('action', 'integration.updated')->latest('id')->firstOrFail());
        $this->assertSame('pathao', $audit->meta['provider']);
        $this->assertContains('is_default', $audit->meta['changed']);

        // S39: status, route_key, credentials can't be patched.
        $this->api($h, 'PATCH', $this->url($store, '/pathao'), ['revision' => 2, 'status' => 'error', 'route_key' => str_repeat('a', 32), 'settings' => ['item_type' => 3]])
            ->assertStatus(422)->assertJsonValidationErrors(['settings'], 'error.details');
        $this->api($h, 'PATCH', $this->url($store, '/pathao'), ['revision' => 2, 'status' => 'error', 'route_key' => str_repeat('a', 32)])->assertOk()
            ->assertJsonPath('data.status', 'connected')->assertJsonPath('data.revision', 2);
    }

    public function test_test_endpoint_reports_balance_and_marks_errors(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        Http::fake(['portal.packzy.com/api/v1/get_balance' => Http::sequence()
            ->push($this->fixture('steadfast/get_balance'))->push($this->fixture('steadfast/get_balance'))->push(['message' => 'Unauthorized'], 401)]);
        $this->connect($h, $store)->assertOk();
        $res = $this->api($h, 'POST', $this->url($store, '/steadfast/test'))->assertOk();
        $this->assertSame(['ok', 'checked_at', 'balance_amount'], array_keys($res->json('data')));
        $res->assertJsonPath('data.ok', true)->assertJsonPath('data.balance_amount', 1234550);

        $this->api($h, 'POST', $this->url($store, '/steadfast/test'))->assertStatus(422)->assertJsonPath('error.code', 'credentials_invalid');
        $this->api($h, 'GET', $this->url($store))->assertJsonPath('data.0.status', 'error')->assertJsonPath('data.0.last_error_code', 'credentials_invalid');
        $this->api($h, 'POST', $this->url($store, '/pathao/test'))->assertNotFound();
    }

    public function test_rotate_webhook_secret_invalidates_the_old_one(): void
    {
        config(['couriers.fake' => true]);
        [, $tenant, $store, $h] = $this->liveShop();
        $old = $this->connect($h, $store)->json('meta.webhook_secret');
        $res = $this->api($h, 'POST', $this->url($store, '/steadfast/webhook-secret'))->assertOk();
        $this->assertSame(['webhook_url', 'webhook_secret'], array_keys($res->json('data')));
        $new = $res->json('data.webhook_secret');
        $this->assertNotSame($old, $new);
        $account = $this->inTenant($tenant, fn () => CourierAccount::query()->firstOrFail());
        $this->assertFalse($account->webhookSecretMatches($old));
        $this->assertTrue($account->webhookSecretMatches($new));
        $this->assertStringEndsWith('/api/v1/webhooks/steadfast/'.$account->route_key, $res->json('data.webhook_url'));

        $this->connect($h, $store, 'pathao')->assertOk()->assertJsonPath('meta.webhook_secret', fn ($s) => is_string($s) && strlen($s) === 40);
        $redx = $this->connect($h, $store, 'redx', ['access_token' => 'redx-token-abcd'])->assertOk();
        $redx->assertJsonPath('meta.webhook_secret', null)->assertJsonPath('data.webhook_url', null)->assertJsonPath('data.webhook_secret_hint', null);
        $this->api($h, 'POST', $this->url($store, '/redx/webhook-secret'))->assertNotFound();
    }

    public function test_disconnect_refuses_with_active_parcels_and_wipes_credentials(): void
    {
        config(['couriers.fake' => true]);
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store);
        $this->connect($h, $store)->assertOk();
        $account = $this->inTenant($tenant, fn () => CourierAccount::query()->firstOrFail());
        $orderId = $this->manual($h, $store, $this->manualBody($variant, 1))->assertCreated()->json('data.id');
        $shipmentId = $this->inTenant($tenant, function () use ($store, $orderId, $account) {
            $s = new Shipment;
            $s->forceFill(['store_id' => $store->id, 'order_id' => $orderId, 'provider' => 'steadfast', 'status' => Shipment::IN_TRANSIT, 'courier_account_id' => $account->id, 'consignment_id' => 'C1'])->save();

            return $s->id;
        });

        $this->api($h, 'DELETE', $this->url($store, '/steadfast'))->assertStatus(409)->assertJsonPath('error.code', 'courier_busy');
        $this->inTenant($tenant, fn () => Shipment::query()->whereKey($shipmentId)->update(['status' => Shipment::DELIVERED]));
        $this->api($h, 'DELETE', $this->url($store, '/steadfast'))->assertNoContent();
        $row = $this->api($h, 'GET', $this->url($store))->json('data.0');
        $this->assertSame(['disconnected', null, null, false, null, null], [$row['status'], $row['credentials_hint'], $row['webhook_url'], $row['is_default'], $row['connected_at'], $row['webhook_secret_hint']]);
        $fresh = $this->inTenant($tenant, fn () => CourierAccount::query()->firstOrFail());
        $this->assertSame([], $fresh->credentials);
        $this->assertNull($fresh->webhook_secret_hash);
        $this->api($h, 'DELETE', $this->url($store, '/steadfast'))->assertNotFound();
        $this->assertSame(1, $this->inTenant($tenant, fn () => $this->platformQuery(AuditLog::class)->where('action', 'integration.disconnected')->count()));
    }

    public function test_areas_are_cached_and_suggested_and_pickup_stores_listed(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        Http::fake([
            'courier-api-sandbox.pathao.com/aladdin/api/v1/issue-token' => Http::response($this->fixture('pathao/issue_token')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/city-list' => Http::response($this->fixture('pathao/city_list')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/cities/1/zone-list' => Http::response($this->fixture('pathao/zone_list')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/stores' => Http::response($this->fixture('pathao/stores')),
        ]);
        $this->connect($h, $store, 'pathao')->assertOk();

        $cities = $this->api($h, 'GET', $this->url($store, '/pathao/areas?level=city'))->assertOk();
        $cities->assertJsonPath('data', [['id' => '1', 'name' => 'Dhaka', 'level' => 'city', 'parent_id' => null], ['id' => '2', 'name' => 'Chittagong', 'level' => 'city', 'parent_id' => null]]);
        $this->assertArrayNotHasKey('meta', $cities->json());
        $this->api($h, 'GET', $this->url($store, '/pathao/areas?level=city'))->assertOk();
        Http::assertSentCount(2); // issue-token (connect; the token is reused) + city-list once (cached 24 h)
        $zones = $this->api($h, 'GET', $this->url($store, '/pathao/areas?level=zone&parent_id=1&district_code=dhaka&thana_code=dhaka-dhanmondi'))->assertOk();
        $zones->assertJsonPath('data.0.id', '298')->assertJsonPath('meta.suggested', ['city_id' => '1', 'zone_id' => '298', 'area_id' => null]);
        $this->api($h, 'GET', $this->url($store, '/pathao/areas?level=city&district_code=chattogram'))->assertJsonPath('meta.suggested', ['city_id' => '2', 'zone_id' => null, 'area_id' => null]);

        // A remembered mapping wins over the name match.
        $this->inTenant($tenant, fn () => app(AreaMapper::class)->remember(
            CourierAccount::query()->where('provider', 'pathao')->firstOrFail(), 'dhaka', 'dhaka-dhanmondi', ['city_id' => '1', 'zone_id' => '299', 'area_id' => '5'], 'Mirpur'));
        $this->api($h, 'GET', $this->url($store, '/pathao/areas?level=city&district_code=dhaka&thana_code=dhaka-dhanmondi'))
            ->assertJsonPath('meta.suggested', ['city_id' => '1', 'zone_id' => '299', 'area_id' => '5']);

        $this->api($h, 'GET', $this->url($store, '/pathao/areas?level=country'))->assertStatus(422)->assertJsonValidationErrors(['level'], 'error.details');
        $this->api($h, 'GET', $this->url($store, '/pathao/areas'))->assertStatus(422);
        $this->api($h, 'GET', $this->url($store, '/pathao/pickup-stores'))->assertOk()
            ->assertJsonPath('data', [['id' => '1234', 'name' => 'Demo Shop', 'address' => 'House 1, Road 2, Dhanmondi']]);
        $this->api($h, 'GET', $this->url($store, '/steadfast/areas?level=city'))->assertNotFound(); // not connected

        Http::fake(['courier-api-sandbox.pathao.com/aladdin/api/v1/cities/2/zone-list' => fn () => throw new ConnectionException('x')]);
        $this->api($h, 'GET', $this->url($store, '/pathao/areas?level=zone&parent_id=2'))->assertStatus(502)->assertJsonPath('error.code', 'provider_unavailable');
    }

    public function test_steadfast_areas_are_empty(): void
    {
        config(['couriers.fake' => true]);
        [, , $store, $h] = $this->liveShop();
        $this->connect($h, $store)->assertOk();
        $this->api($h, 'GET', $this->url($store, '/steadfast/areas?level=city&district_code=dhaka'))->assertOk()
            ->assertJsonPath('data', [])->assertJsonPath('meta.suggested', null);
        $this->api($h, 'GET', $this->url($store, '/steadfast/pickup-stores'))->assertOk()->assertJsonPath('data', []);
    }

    #[Group('security')]
    public function test_staff_can_read_but_not_write_and_foreign_stores_are_404(): void
    {
        config(['couriers.fake' => true]);
        [, $tenant, $store, $h] = $this->liveShop();
        $this->connect($h, $store)->assertOk();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $this->api($staff, 'GET', $this->url($store))->assertOk();
        $this->api($staff, 'GET', $this->url($store, '/steadfast/areas?level=city'))->assertOk();
        foreach ([
            ['PUT', '/pathao', ['mode' => 'sandbox', 'credentials' => self::PATHAO]],
            ['PATCH', '/steadfast', ['revision' => 1, 'is_default' => true]],
            ['POST', '/steadfast/test', []],
            ['POST', '/steadfast/webhook-secret', []],
            ['DELETE', '/steadfast', []],
        ] as [$method, $path, $body]) {
            $this->api($staff, $method, $this->url($store, $path), $body)->assertForbidden();
        }
        $this->api($admin, 'POST', $this->url($store, '/steadfast/test'))->assertOk();

        [, , $storeB, $hB] = $this->liveShop('b');
        $this->assertTenantIsolation($hB, [
            ['GET', $this->url($store)],
            ['PUT', $this->url($store, '/pathao'), ['mode' => 'sandbox', 'credentials' => self::PATHAO]],
            ['PATCH', $this->url($store, '/steadfast'), ['revision' => 1]],
            ['POST', $this->url($store, '/steadfast/test')],
            ['POST', $this->url($store, '/steadfast/webhook-secret')],
            ['DELETE', $this->url($store, '/steadfast')],
            ['GET', $this->url($store, '/steadfast/areas?level=city')],
            ['GET', $this->url($store, '/steadfast/pickup-stores')],
        ]);
        $this->api($hB, 'GET', $this->url($storeB))->assertOk()->assertJsonPath('data.0.status', 'not_connected');
    }

    public function test_couriers_fake_refuses_to_boot_in_production(): void
    {
        config(['couriers.fake' => true]);
        $this->app['env'] = 'production';
        try {
            CouriersServiceProvider::assertSafeConfiguration($this->app);
            $this->fail('expected a refusal');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('COURIERS_FAKE', $e->getMessage());
        } finally {
            $this->app['env'] = 'testing';
        }
        config(['couriers.fake' => false]);
        $this->app['env'] = 'production';
        CouriersServiceProvider::assertSafeConfiguration($this->app);
        $this->app['env'] = 'testing';
        $this->assertTrue(true);
    }
}
