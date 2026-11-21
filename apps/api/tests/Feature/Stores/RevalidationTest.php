<?php

namespace Tests\Feature\Stores;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use RuntimeException;
use Tests\TestCase;

class RevalidationTest extends TestCase
{
    use RefreshDatabase;

    /** @var array{0: mixed, 1: int} next fake storefront response body + status */
    private array $next = [['ok' => true], 200];

    private function respond(mixed $body, int $status): void
    {
        $this->next = [$body, $status];
    }

    private function configure(): void
    {
        // One dynamic fake (provisioning also triggers a revalidation).
        Http::fake(['storefront.test/*' => fn () => Http::response($this->next[0], $this->next[1])]);
        config([
            'storeplix.revalidate_url' => 'http://storefront.test/api/revalidate',
            'storeplix.revalidate_secret' => 'test-secret',
        ]);
    }

    public function test_changes_dispatch_revalidation_for_the_store(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop', ['shop.localhost']);
        Queue::fake();

        $this->withHeaders($this->tenantHeaders($user, $tenant))
            ->patchJson("/api/v1/stores/{$store->id}/settings", ['branding' => ['primary_color' => '#112233']])->assertOk();
        Queue::assertPushed(RevalidateStorefront::class, fn ($job) => $job->storeId === $store->id && $job->tenantId === $tenant->id);

        $this->travel(3)->seconds(); // past the 2 s uniqueness debounce
        Queue::fake();
        $this->tenancy()->run($tenant, function () use ($store) {
            $store->update(['status' => $store->status === Store::STATUS_ACTIVE ? Store::STATUS_DRAFT : Store::STATUS_ACTIVE]);
        });
        Queue::assertPushed(RevalidateStorefront::class, 1);

        // Irrelevant store columns don't trigger a revalidation.
        $this->travel(3)->seconds();
        Queue::fake();
        $this->tenancy()->run($tenant, fn () => $store->update(['timezone' => 'Asia/Kolkata']));
        Queue::assertNothingPushed();

        $this->travel(3)->seconds();
        Queue::fake();
        $this->tenancy()->run($tenant, fn () => StoreDomain::query()->where('hostname', 'shop.localhost')->first()->delete());
        Queue::assertPushed(RevalidateStorefront::class, fn ($job) => $job->extraHosts === ['shop.localhost']);
    }

    public function test_job_posts_all_hosts_with_bearer_secret(): void
    {
        $this->configure();
        [, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop', ['shop.localhost']);

        $this->tenancy()->run($tenant, fn () => (new RevalidateStorefront($store->id, ['old.example.com']))->handle());

        Http::assertSent(fn (Request $r) => $r->url() === 'http://storefront.test/api/revalidate'
            && $r->hasHeader('Authorization', 'Bearer test-secret')
            && collect($r['hosts'])->sort()->values()->all() === ['old.example.com', 'shop.localhost', 'shop.storeplix.test']);
    }

    public function test_retries_on_500_and_network_errors(): void
    {
        $this->configure();
        [, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $this->respond('boom', 500);

        $job = (new RevalidateStorefront($store->id))->withFakeQueueInteractions();
        $this->assertSame(5, $job->tries);
        $this->assertSame([5, 30, 120, 600], $job->backoff());

        $this->expectException(RuntimeException::class); // thrown → the worker retries with backoff
        $this->tenancy()->run($tenant, fn () => $job->handle());
    }

    public function test_no_retry_on_401_and_disabled_503(): void
    {
        $this->configure();
        [, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');

        $this->respond(['error' => 'unauthorized'], 401);
        $job = (new RevalidateStorefront($store->id))->withFakeQueueInteractions();
        $this->tenancy()->run($tenant, fn () => $job->handle());
        $job->assertFailed();
        $job->assertNotReleased();

        $this->respond(['error' => ['code' => 'revalidate_disabled']], 503);
        $job = (new RevalidateStorefront($store->id))->withFakeQueueInteractions();
        $this->tenancy()->run($tenant, fn () => $job->handle());
        $job->assertNotFailed();
        $job->assertNotReleased();
    }

    public function test_noop_when_not_configured(): void
    {
        Http::fake();
        [, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');

        $this->tenancy()->run($tenant, fn () => (new RevalidateStorefront($store->id))->handle());

        Http::assertNothingSent();
    }
}
