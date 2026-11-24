<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\Webhooks;

use App\Domain\Billing\Models\Plan;
use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\Models\WebhookEndpoint;
use App\Domain\Developer\Webhooks\Sending\HostResolver;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Testing\TestResponse;
use Tests\Support\RoleFixtures;

/** Phase 8.4 webhook helpers: real sender with Http::fake + fake DNS by default; endpoints through the API. */
trait WebhookFixtures
{
    use RoleFixtures;

    protected const HOOK = 'https://hooks.example.com/storeplix';

    protected const PUBLIC_IP = '93.184.216.34';

    protected FakeHostResolver $dns;

    protected function setUpWebhooks(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        config(['webhooks_out.fake' => false, 'webhooks_out.allow_http' => false]);
        $this->dns = new FakeHostResolver(['hooks.example.com' => [self::PUBLIC_IP], 'other.example.com' => ['93.184.216.35']]);
        $this->app->instance(HostResolver::class, $this->dns);
    }

    protected function hookUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/webhook-endpoints".$suffix;
    }

    /** @param list<string> $events */
    protected function addEndpoint(array $h, Store $store, array $events = ['order.created'], string $url = self::HOOK): TestResponse
    {
        return $this->api($h, 'POST', $this->hookUrl($store), ['url' => $url, 'events' => $events]);
    }

    /** @param list<string> $events */
    protected function endpointId(array $h, Store $store, array $events = ['order.created'], string $url = self::HOOK): string
    {
        return $this->addEndpoint($h, $store, $events, $url)->assertCreated()->json('data.id');
    }

    /** @return Collection<int, WebhookDelivery> oldest first */
    protected function deliveriesOf(Tenant $tenant, ?string $type = null): Collection
    {
        return $this->platformQuery(WebhookDelivery::class)->where('tenant_id', $tenant->id)
            ->when($type !== null, fn ($q) => $q->where('event_type', $type))
            ->orderBy('created_at')->orderBy('id')->get();
    }

    protected function endpointRow(Tenant $tenant, string $id): WebhookEndpoint
    {
        return $this->platformQuery(WebhookEndpoint::class)->where('tenant_id', $tenant->id)->whereKey($id)->firstOrFail();
    }

    protected function growth(Tenant $tenant): void
    {
        $this->planFor($tenant, Plan::GROWTH);
    }
}
