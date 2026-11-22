<?php

declare(strict_types=1);

namespace App\Domain\Domains\Console;

use App\Domain\Domains\Providers\CustomHostnameProvider;
use App\Domain\Domains\Providers\ProviderException;
use App\Domain\Tenancy\Support\DomainPlatformLookup;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;
use Throwable;

/**
 * P6-14 `domains:reconcile-provider` (daily 03:30 Asia/Dhaka, cloudflare driver): deletes provider custom hostnames
 * older than 1 h that no store_domains row references (orphans after a crash or a lost job). `--dry-run` lists only.
 */
class ReconcileProviderHostnames extends Command
{
    protected $signature = 'domains:reconcile-provider {--dry-run : List orphans without deleting them}';

    protected $description = 'Delete provider custom hostnames that no domain row references';

    public function handle(CustomHostnameProvider $provider, DomainPlatformLookup $lookup): int
    {
        $dry = (bool) $this->option('dry-run');
        $cutoff = CarbonImmutable::now()->subHour();
        $orphans = 0;
        $page = 1;
        try {
            do {
                $result = $provider->list($page);
                $ids = array_map(fn ($h) => $h->id, $result['items']);
                $referenced = array_flip($lookup->referencedProviderIds($ids));
                foreach ($result['items'] as $hostname) {
                    if (isset($referenced[$hostname->id]) || ! self::olderThan($hostname->createdAt, $cutoff)) {
                        continue;
                    }
                    $orphans++;
                    $this->line(($dry ? '[dry-run] orphan ' : 'deleting orphan ').$hostname->id.' '.$hostname->hostname);
                    if (! $dry) {
                        $provider->delete($hostname->id);
                    }
                }
                $page++;
            } while ($result['has_more'] && $page <= 1000);
        } catch (ProviderException $e) {
            $this->error('Provider error: '.$e->getMessage());

            return self::FAILURE;
        }
        $this->info(($dry ? 'Found ' : 'Deleted ')."{$orphans} orphan hostname(s).");

        return self::SUCCESS;
    }

    private static function olderThan(?string $createdAt, CarbonImmutable $cutoff): bool
    {
        if ($createdAt === null || $createdAt === '') {
            return false;
        }
        try {
            return CarbonImmutable::parse($createdAt)->lessThan($cutoff);
        } catch (Throwable) {
            return false;
        }
    }
}
