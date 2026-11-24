<?php

namespace App\Domain\Stores\Services;

use App\Domain\Inventory\Locations\Locations;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Creates a store with its platform subdomain "{slug}.{PLATFORM_DOMAIN}" and default content (theme, pages, menus).
 * Always runs inside the owning tenant's context.
 */
class StoreProvisioner
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
        private readonly StoreContentProvisioner $content,
    ) {}

    /**
     * @param  array{name: string, slug: string, country?: string, currency?: string, business_categories?: list<string>, name_bn?: string|null, timezone?: string, status?: string}  $data
     * @param  list<string>  $extraPlatformHosts  additional active platform hostnames (e.g. dev aliases)
     */
    /**
     * @throws StoreLimitReachedException when the tenant already owns a store (D1: one store per tenant)
     */
    public function provision(Tenant $tenant, array $data, array $extraPlatformHosts = []): Store
    {
        // Fast path for a friendly error; the UNIQUE(stores.tenant_id) constraint is the real guard.
        // B6 (Phase 5b): a plain scoped query inside the tenant (same filter as before, visible under RLS).
        if ($this->tenantHasStore($tenant)) {
            throw new StoreLimitReachedException;
        }

        try {
            return $this->create($tenant, $data, $extraPlatformHosts);
        } catch (UniqueConstraintViolationException $e) {
            // Lost a race with a concurrent create for the same tenant (or the same slug).
            if ($this->tenantHasStore($tenant)) {
                throw new StoreLimitReachedException;
            }

            // P5B-8: the global slug index (another tenant's store, invisible under RLS) → 422, never 500.
            if (str_contains($e->getMessage(), 'slug')) {
                throw ValidationException::withMessages(['slug' => ['This slug is already taken.']]);
            }

            throw $e;
        }
    }

    private function tenantHasStore(Tenant $tenant): bool
    {
        return $this->context->run($tenant, fn () => Store::query()->exists());
    }

    /**
     * @param  array<string, mixed>  $data
     * @param  list<string>  $extraPlatformHosts
     */
    private function create(Tenant $tenant, array $data, array $extraPlatformHosts): Store
    {
        return $this->context->run($tenant, fn () => DB::transaction(function () use ($data, $extraPlatformHosts) {
            $slug = strtolower($data['slug']);

            $store = Store::query()->create([
                'name' => $data['name'],
                'slug' => $slug,
                'status' => $data['status'] ?? Store::STATUS_DRAFT,
                'country' => strtoupper($data['country'] ?? 'BD'),
                'currency' => strtoupper($data['currency'] ?? 'BDT'),
                'business_categories' => array_values($data['business_categories'] ?? []),
                'name_bn' => $data['name_bn'] ?? null,
                'timezone' => $data['timezone'] ?? 'Asia/Dhaka',
            ]);

            $hosts = array_values(array_unique([
                self::platformHostname($slug),
                ...array_map('strtolower', $extraPlatformHosts),
            ]));

            foreach ($hosts as $i => $host) {
                StoreDomain::query()->create([
                    'store_id' => $store->id,
                    'hostname' => $host,
                    'type' => StoreDomain::TYPE_PLATFORM,
                    'status' => StoreDomain::STATUS_ACTIVE, // platform hosts need no DNS verification
                    'is_primary' => $i === 0,
                    'verified_at' => now(),
                ]);
            }

            StoreSetting::query()->create(['store_id' => $store->id]);

            // PHASE-8-8C §3.1: every store starts with its default ("Main warehouse") = online stock location.
            Locations::ensureDefault($store->id);

            // Phase 3 (P3-13): active theme, default pages and menus.
            $this->content->ensure($store);

            $this->audit->log('store.created', $store, ['slug' => $slug]);

            return $store->load(['primaryDomain', 'settings']);
        }));
    }

    public static function platformHostname(string $slug): string
    {
        return strtolower($slug).'.'.config('storeplix.platform_domain');
    }
}
