<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Billing\FeatureGate;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Collection;

/** The store's tracking integrations that send (connected / needs attention), and the plan check (P89D-40). */
final class TrackingIntegrations
{
    /** @return Collection<int, StoreIntegration> in catalogue order */
    public static function active(string $storeId): Collection
    {
        return StoreIntegration::query()->where('store_id', $storeId)
            ->whereIn('provider', IntegrationProvider::TRACKING)
            ->whereIn('status', [...StoreIntegration::ACTIVE, StoreIntegration::ERROR])
            ->get()->sortBy(fn (StoreIntegration $i) => array_search($i->provider, IntegrationProvider::ALL, true))->values();
    }

    /** True when the store has any tracking integration row that is not disconnected (checkout context, P89D-2). */
    public static function any(string $storeId): bool
    {
        return StoreIntegration::query()->where('store_id', $storeId)->whereIn('provider', IntegrationProvider::TRACKING)
            ->where('status', '<>', StoreIntegration::DISCONNECTED)->exists();
    }

    public static function planAllows(StoreIntegration $integration): bool
    {
        $feature = IntegrationProvider::feature($integration->provider);
        if ($feature === null) {
            return true;
        }
        $tenant = app(TenantContext::class)->tenant();

        return $tenant !== null && FeatureGate::allows($tenant, $feature);
    }

    /** No usable token: never saved, or flagged invalid / expired (P89D-16). GTM has no token. */
    public static function hasToken(StoreIntegration $integration): bool
    {
        if ($integration->provider === IntegrationProvider::GTM_SERVER) {
            return true;
        }
        if ($integration->hasAttention('token_invalid') || $integration->hasAttention('token_expired')) {
            return false;
        }
        $field = $integration->provider === IntegrationProvider::GA4 ? 'api_secret' : 'access_token';

        return is_string($integration->secrets()[$field] ?? null) && $integration->secrets()[$field] !== '';
    }
}
