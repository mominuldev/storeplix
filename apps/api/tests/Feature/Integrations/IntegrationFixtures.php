<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Feeds\Drivers\FakeFeedDriver;
use App\Domain\Feeds\Models\CatalogItem;
use App\Domain\Feeds\Models\CatalogSyncRun;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\PublicHostResolver;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tracking\Models\OrderTrackingContext;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\CommerceFixtures;
use Tests\Support\RoleFixtures;

/**
 * Phase 8.9d part A helpers: integrations through the API (pixels by PUT, feeds by the fake OAuth round trip + account
 * choice), raw rows through the platform connection, a DNS resolver answering without the network, and orders placed
 * through the storefront checkout with a tracking context.
 */
trait IntegrationFixtures
{
    use CommerceFixtures, RoleFixtures;

    protected const META_TOKEN = 'EAABsbCS1iHgBAKZBZCtestTOKENvalue0042';

    protected const GA4_SECRET = 'mpSecretValue9876';

    protected const TIKTOK_TOKEN = 'tiktokEventsTokenValue5555';

    protected const META_PIXEL = '1234567890123456';

    protected const TIKTOK_PIXEL = 'C0ABCDEFGHIJ12345678';

    protected function setUpIntegrations(bool $throttle = false): void
    {
        if (! $throttle) {
            $this->withoutMiddleware(ThrottleRequests::class);
        }
        Mail::fake();
        config(['tracking.fake' => true, 'feeds.fake' => true]);
        FakeFeedDriver::$held = [];
        $this->app->instance(PublicHostResolver::class, new class extends PublicHostResolver
        {
            /** @var array<string, list<string>> */
            public static array $answers = ['sgtm.example.com' => ['93.184.216.34']];

            public function resolve(string $host): array
            {
                return self::$answers[$host] ?? [];
            }
        });
    }

    /** @param array<string, list<string>> $answers */
    protected function resolveHosts(array $answers): void
    {
        $resolver = app(PublicHostResolver::class);
        $resolver::$answers = $answers;
    }

    protected function intUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/integrations".$suffix;
    }

    /** @return array{settings: array<string, mixed>, credentials?: array<string, string>} */
    protected function pixelBody(string $provider, array $settings = [], ?array $credentials = null): array
    {
        [$base, $creds] = match ($provider) {
            'meta_pixel' => [['pixel_id' => self::META_PIXEL], ['access_token' => self::META_TOKEN]],
            'ga4' => [['measurement_id' => 'G-ABC123XYZ'], ['api_secret' => self::GA4_SECRET]],
            'tiktok_pixel' => [['pixel_id' => self::TIKTOK_PIXEL], ['access_token' => self::TIKTOK_TOKEN]],
            'gtm_server' => [['container_id' => 'GTM-ABCD12', 'tagging_server_url' => 'https://sgtm.example.com', 'measurement_id' => 'G-ABC123XYZ'], []],
            default => [[], []],
        };

        return array_filter(['settings' => $settings + $base, 'credentials' => $credentials ?? ($creds !== [] ? $creds : null)], fn ($v) => $v !== null);
    }

    /** PUT a tracking / AI integration (first connect: no revision). */
    protected function connect(array $h, Store $store, string $provider, array $settings = [], ?array $credentials = null, ?int $revision = null): TestResponse
    {
        $body = $this->pixelBody($provider, $settings, $credentials);
        if ($revision !== null) {
            $body['revision'] = $revision;
        }

        return $this->api($h, 'PUT', $this->intUrl($store, "/{$provider}"), $body);
    }

    /** Fake OAuth round trip → setup_required row. Returns the redirect location. */
    protected function oauth(array $h, Store $store, string $provider = 'meta_catalog'): string
    {
        $url = $this->api($h, 'POST', $this->intUrl($store, "/{$provider}/oauth/start"))->assertOk()->json('data.authorize_url');
        $query = [];
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

        return $this->oauthCallback($provider, $query)->assertStatus(303)->headers->get('Location');
    }

    /** @param array<string, mixed> $query */
    protected function oauthCallback(string $provider, array $query): TestResponse
    {
        return $this->flushHeaders()->get("/api/v1/integrations/oauth/{$provider}/callback?".http_build_query($query));
    }

    /** OAuth + account choice → connected feed (first sync runs inline on the sync queue). */
    protected function connectFeed(array $h, Store $store, string $provider = 'meta_catalog', string $account = '100200300'): array
    {
        $this->oauth($h, $store, $provider);

        return $this->api($h, 'PUT', $this->intUrl($store, "/{$provider}/account"), ['account_id' => $account])->assertOk()->json('data');
    }

    protected function integrationRow(Tenant $tenant, Store $store, string $provider): ?StoreIntegration
    {
        return $this->platformQuery(StoreIntegration::class)->where('tenant_id', $tenant->id)->where('store_id', $store->id)->where('provider', $provider)->first();
    }

    /** @return Collection<int, TrackingEvent> */
    protected function trackingRows(Tenant $tenant, ?string $provider = null): Collection
    {
        return $this->platformQuery(TrackingEvent::class)->where('tenant_id', $tenant->id)
            ->when($provider !== null, fn ($q) => $q->where('provider', $provider))->orderBy('created_at')->orderBy('id')->get();
    }

    /** @return Collection<int, CatalogItem> */
    protected function catalogItems(Tenant $tenant, ?string $integrationId = null): Collection
    {
        return $this->platformQuery(CatalogItem::class)->where('tenant_id', $tenant->id)
            ->when($integrationId !== null, fn ($q) => $q->where('store_integration_id', $integrationId))->orderBy('id')->get();
    }

    /** @return Collection<int, CatalogSyncRun> */
    protected function syncRuns(Tenant $tenant): Collection
    {
        return $this->platformQuery(CatalogSyncRun::class)->where('tenant_id', $tenant->id)->orderBy('started_at')->orderBy('id')->get();
    }

    protected function contextRow(Tenant $tenant, string $orderId): ?OrderTrackingContext
    {
        return $this->platformQuery(OrderTrackingContext::class)->where('tenant_id', $tenant->id)->where('order_id', $orderId)->first();
    }

    /** @return list<array{action: string, meta: array<string, mixed>}> */
    protected function audits(Tenant $tenant, string $prefix = 'integration.'): array
    {
        return $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', $prefix.'%')->orderBy('id')->get()
            ->map(fn (AuditLog $a) => ['action' => $a->action, 'meta' => (array) $a->meta])->all();
    }

    /** Storefront checkout with a CheckoutInput.tracking block. Returns the order id. */
    protected function trackedOrder(Store $store, string $variant, array $tracking = [], array $override = []): string
    {
        $number = $this->placeOrder($store, $variant, 1, $override + ($tracking !== [] ? ['tracking' => $tracking] : []))->json('data.order.number');

        return (string) $this->platformTable('orders')->where('store_id', $store->id)->where('number', $number)->value('id');
    }

    protected function confirm(array $h, Store $store, string $orderId): TestResponse
    {
        return $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$orderId}/confirm", ['notify_customer' => false])->assertOk();
    }

    /** @param list<array<string, mixed>> $events @param array<string, mixed> $context */
    protected function beacon(Store $store, array $events, array $context = ['consent' => 'not_required'], array $extra = []): TestResponse
    {
        return $this->sf($store, 'POST', '/tracking/events', ['events' => $events, 'context' => $context], null, $extra);
    }

    /** @return array<string, mixed> */
    protected static function browserEvent(string $name, array $extra = []): array
    {
        return $extra + ['event_id' => strtolower((string) Str::ulid()), 'name' => $name, 'occurred_at' => now()->toIso8601ZuluString(), 'page_path' => '/'];
    }
}
