<?php

namespace App\Domain\Stores\Console;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Services\StoreContentProvisioner;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/** php artisan stores:ensure-content — idempotent; run by DemoSeeder and on deploy (P3-13). */
class EnsureStoreContent extends Command
{
    protected $signature = 'stores:ensure-content {--store= : Only this store id or slug}';

    protected $description = 'Give every store its default theme, pages and menus (idempotent).';

    public function handle(StoreContentProvisioner $provisioner, TenantContext $context): int
    {
        $query = Store::withoutTenancy()->orderBy('created_at');
        if ($only = $this->option('store')) {
            $query->where(fn ($q) => $q->whereKey(strtolower($only))->orWhere('slug', strtolower($only)));
        }

        $count = 0;
        foreach ($query->cursor() as $store) {
            $result = $context->run($store->tenant_id, fn () => $provisioner->ensure($store));
            $count++;
            $this->line(sprintf(
                '%s: theme %s, %d page(s), %d menu(s) created',
                $store->slug, $result['theme'] ? 'installed' : 'ok', $result['pages'], $result['menus'],
            ));
        }

        $this->info("Checked {$count} store(s).");

        return self::SUCCESS;
    }
}
