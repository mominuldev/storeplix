<?php

namespace App\Domain\Stores\Revalidation;

use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;

/**
 * QA M-1: tells the storefront to expire its tag cache for every host of a store.
 * POST {STOREFRONT_REVALIDATE_URL} {"hosts":[...]} with Bearer {REVALIDATE_SECRET}.
 *
 * 2xx done · 401/422 fail (config error, no retry) · 503 revalidate_disabled → warn, no retry ·
 * network error / other 5xx → retry (5 tries, backoff 5/30/120/600 s). Empty env → no-op.
 */
class RevalidateStorefront implements ShouldBeUnique, ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 5;

    /** Debounce bulk edits. */
    public int $uniqueFor = 2;

    /**
     * @param  list<string>  $extraHosts  old hostnames of changed/deleted domains
     */
    public function __construct(
        public readonly string $storeId,
        public readonly array $extraHosts = [],
    ) {}

    public function uniqueId(): string
    {
        return $this->storeId;
    }

    /** @return list<int> */
    public function backoff(): array
    {
        return [5, 30, 120, 600];
    }

    public function handle(): void
    {
        $url = (string) config('storeplix.revalidate_url');
        $secret = (string) config('storeplix.revalidate_secret');

        if ($url === '' || $secret === '') {
            Log::info('storefront.revalidate_skipped', ['store_id' => $this->storeId, 'reason' => 'not_configured']);

            return;
        }

        $hosts = StoreDomain::query()->where('store_id', $this->storeId)->pluck('hostname')
            ->concat($this->extraHosts)->map(fn ($h) => strtolower($h))->unique()->values()->all();

        if ($hosts === []) {
            return;
        }

        try {
            $response = Http::timeout(5)->acceptJson()->withToken($secret)->post($url, ['hosts' => $hosts]);
        } catch (ConnectionException $e) {
            Log::warning('storefront.revalidate_unreachable', ['store_id' => $this->storeId, 'error' => $e->getMessage()]);

            throw $e; // retried with backoff
        }

        if ($response->successful()) {
            return;
        }

        $status = $response->status();

        if (in_array($status, [401, 422], true)) {
            Log::error('storefront.revalidate_rejected', ['store_id' => $this->storeId, 'status' => $status]);
            $this->fail(new RuntimeException("Storefront revalidation rejected with HTTP {$status} (check REVALIDATE_SECRET / payload)."));

            return;
        }

        if ($status === 503 && ($response->json('error.code') ?? $response->json('code')) === 'revalidate_disabled') {
            Log::warning('storefront.revalidate_disabled', ['store_id' => $this->storeId]);

            return;
        }

        throw new RuntimeException("Storefront revalidation failed with HTTP {$status}."); // retried
    }
}
