<?php

namespace App\Domain\Shipping\Console;

use App\Domain\Shipping\ShippingService;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/** P5-8 backfill: gives every store without delivery zones the default Inside Dhaka / Outside Dhaka zones. Idempotent. */
class ProvisionShippingDefaults extends Command
{
    protected $signature = 'shipping:provision-defaults {--store= : only this store slug}';

    protected $description = 'Create the default delivery zones (Inside Dhaka ৳70, Outside Dhaka ৳130) for stores without any';

    public function handle(ShippingService $shipping, TenantContext $context): int
    {
        $created = 0;
        Store::withoutTenancy()
            ->when($this->option('store'), fn ($q, $slug) => $q->where('slug', $slug))
            ->orderBy('id')
            ->each(function (Store $store) use ($shipping, $context, &$created) {
                $context->run($store->tenant_id, function () use ($store, $shipping, &$created) {
                    if ($shipping->provisionDefaults($store)) {
                        $created++;
                    }
                });
            });
        $this->info("Default delivery zones created for {$created} store(s).");

        return self::SUCCESS;
    }
}
