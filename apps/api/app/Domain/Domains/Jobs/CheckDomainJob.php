<?php

declare(strict_types=1);

namespace App\Domain\Domains\Jobs;

use App\Domain\Domains\DomainChecker;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * §2.2: one domain's scheduled check, inside its tenant. Dispatched by `domains:check` (and once right after add).
 * Unique per domain for 5 minutes; a domain busy with a concurrent re-check is simply picked up again next minute.
 */
class CheckDomainJob implements ShouldBeUnique, ShouldQueue
{
    use Queueable, TenantAware;

    public const QUEUE = 'domains';

    public int $tries = 3;

    public int $timeout = 60;

    public int $uniqueFor = 300;

    public function __construct(public readonly string $domainId)
    {
        $this->onQueue(self::QUEUE);
    }

    public function uniqueId(): string
    {
        return 'domain-check:'.$this->domainId;
    }

    public function handle(DomainChecker $checker): void
    {
        $domain = StoreDomain::query()->find($this->domainId);
        if ($domain === null || $domain->isPlatform()) {
            return;
        }
        try {
            $checker->check($domain);
        } catch (LockTimeoutException) {
            // Another check holds the domain; next_check_at is unchanged, so discovery dispatches it again.
        }
    }
}
