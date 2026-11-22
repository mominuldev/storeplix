<?php

declare(strict_types=1);

namespace App\Domain\Domains\Jobs;

use App\Domain\Domains\Providers\CloudflareCustomHostnames;
use App\Domain\Domains\Providers\CustomHostnameProvider;
use App\Domain\Domains\Providers\FakeCustomHostnames;
use App\Domain\Tenancy\Support\DomainPlatformLookup;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;

/**
 * P6-14: removes a provider custom hostname after its row stopped using it (remove, expiry, SSL failure, release,
 * store delete). 404 = done; 5 tries with backoff. Touches no tenant rows; it only skips a hostname some row
 * (re-)adopted in the meantime (platform lookup, ids only).
 */
class DeleteProviderHostnameJob implements ShouldQueue
{
    use Queueable;

    public int $tries = 5;

    public int $timeout = 60;

    /** @param string|null $formerDomainId the row being deleted right now (store cascade); its reference doesn't count */
    public function __construct(public readonly string $provider, public readonly string $providerHostnameId, public readonly ?string $formerDomainId = null)
    {
        $this->onQueue(CheckDomainJob::QUEUE);
    }

    /** @return list<int> */
    public function backoff(): array
    {
        return [10, 60, 300, 900];
    }

    public function handle(DomainPlatformLookup $lookup): void
    {
        if ($lookup->providerHostnameReferenced($this->providerHostnameId, $this->formerDomainId)) {
            Log::info('domains.provider_delete_skipped', ['provider_hostname_id' => $this->providerHostnameId, 'reason' => 'referenced']);

            return;
        }
        self::providerFor($this->provider)->delete($this->providerHostnameId);
        Log::info('domains.provider_hostname_deleted', ['provider' => $this->provider, 'provider_hostname_id' => $this->providerHostnameId]);
    }

    public static function providerFor(string $name): CustomHostnameProvider
    {
        return $name === 'fake' ? app(FakeCustomHostnames::class) : app(CloudflareCustomHostnames::class);
    }
}
