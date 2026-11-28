<?php

declare(strict_types=1);

namespace App\Domain\Integrations;

use App\Domain\Billing\FeatureGate;
use App\Domain\Feeds\Models\CatalogItem;
use App\Domain\Identity\Models\User;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\Settings\ProviderSettings;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;

/**
 * PHASE-8-9D §4.1: IntegrationSummary and StoreIntegration. Never a secret: `credentials` stays hidden on the model and
 * only `credentials_hint` (`••••` + last 4 per field) is presented (P89D-5/7). Internal secrets (OAuth tokens, the site
 * verification token) have no hint at all.
 */
final class IntegrationPresenter
{
    /** @return array<string, mixed> IntegrationSummary */
    public static function summary(string $provider, ?StoreIntegration $row): array
    {
        return [
            'provider' => $provider,
            'kind' => IntegrationProvider::kind($provider),
            'status' => self::status($row),
            'summary' => self::line($provider, $row),
            'plan_required' => self::planRequired($provider),
            'attention' => self::attention($row),
        ];
    }

    /** @return array<string, mixed> StoreIntegration */
    public static function full(string $provider, ?StoreIntegration $row, bool $readOnly = false): array
    {
        $class = ProviderSettings::for($provider);
        $context = app(TenantContext::class);
        $manage = ! $readOnly && $context->allows(Permission::IntegrationsManage);
        $status = self::status($row);
        $active = in_array($status, StoreIntegration::ACTIVE, true) || $status === StoreIntegration::ERROR;
        $connectedBy = $row?->connected_by !== null ? User::query()->find($row->connected_by) : null;

        return [
            'provider' => $provider,
            'kind' => IntegrationProvider::kind($provider),
            'status' => $status,
            'settings' => $row === null ? null : array_replace($class::defaults(), (array) $row->settings),
            'defaults' => $class::defaults(),
            'credentials_hint' => (object) ($row !== null ? array_intersect_key((array) $row->credentials_hint, $class::credentialFields()) : []),
            'token_expires_at' => IntegrationProvider::isFeed($provider) ? UserRef::iso($row?->token_expires_at) : null,
            'attention' => self::attention($row),
            'last_verified_at' => UserRef::iso($row?->last_verified_at),
            'last_error_code' => $row?->last_error_code,
            'connected_by' => UserRef::of($connectedBy),
            'connected_at' => UserRef::iso($row?->connected_at),
            'plan_required' => self::planRequired($provider),
            'can' => [
                'manage' => $manage,
                'send_test' => $manage && IntegrationProvider::isTracking($provider) && $active,
                'view_events' => IntegrationProvider::isTracking($provider) && $context->allowsAny(Permission::IntegrationsManage, Permission::MarketingManage),
                'sync_now' => $manage && IntegrationProvider::isFeed($provider) && in_array($status, StoreIntegration::ACTIVE, true),
            ],
            'revision' => $row?->revision ?? 0,
        ];
    }

    public static function status(?StoreIntegration $row): string
    {
        return $row?->status ?? StoreIntegration::NOT_CONNECTED;
    }

    /** The feature key the current plan lacks (card shows "Upgrade"); null when included. */
    public static function planRequired(string $provider): ?string
    {
        $feature = IntegrationProvider::feature($provider);
        $tenant = app(TenantContext::class)->tenant();
        if ($feature === null || $tenant === null) {
            return null;
        }

        return FeatureGate::allows($tenant, $feature) ? null : $feature->value;
    }

    /** @return list<array{reason: string, count: int|null, since: string}> */
    public static function attention(?StoreIntegration $row): array
    {
        $out = array_values((array) ($row?->attention ?? []));
        $provider = $row?->provider;
        if ($row !== null && $provider !== null && $row->status !== StoreIntegration::DISCONNECTED && self::planRequired($provider) !== null
            && ! in_array('plan_required', array_column($out, 'reason'), true)) {
            $out[] = ['reason' => 'plan_required', 'count' => null, 'since' => UserRef::iso($row->updated_at) ?? now()->toIso8601ZuluString()];
        }

        return array_map(fn (array $a) => ['reason' => (string) $a['reason'], 'count' => isset($a['count']) ? (int) $a['count'] : null, 'since' => (string) $a['since']], $out);
    }

    /** One line under the name on the Integrations list (§4.1). */
    private static function line(string $provider, ?StoreIntegration $row): ?string
    {
        if ($row === null || $row->status === StoreIntegration::DISCONNECTED) {
            return null;
        }
        $id = fn (string $key) => is_string($v = $row->setting($key)) && strlen($v) > 10 ? substr($v, 0, 4).'…'.substr($v, -4) : (string) $row->setting($key);
        $server = $row->hasAttention('token_invalid') ? 'off' : 'on';

        return match ($provider) {
            IntegrationProvider::META_PIXEL => 'Pixel '.$id('pixel_id').' · CAPI '.$server,
            IntegrationProvider::TIKTOK_PIXEL => 'Pixel '.$id('pixel_id').' · Events API '.$server,
            IntegrationProvider::GA4 => $row->setting('measurement_id').' · Measurement Protocol '.$server,
            IntegrationProvider::GTM_SERVER => $row->setting('container_id').' → '.parse_url((string) $row->setting('tagging_server_url'), PHP_URL_HOST),
            IntegrationProvider::META_CATALOG, IntegrationProvider::GOOGLE_MERCHANT => self::feedLine($provider, $row),
            default => 'On',
        };
    }

    private static function feedLine(string $provider, StoreIntegration $row): string
    {
        if ($row->status === StoreIntegration::SETUP_REQUIRED) {
            return $provider === IntegrationProvider::META_CATALOG ? 'Choose a catalog to finish connecting' : 'Choose a Merchant Center account to finish connecting';
        }
        $total = CatalogItem::query()->where('store_integration_id', $row->id)->where('status', '<>', 'excluded')->count();
        $live = CatalogItem::query()->where('store_integration_id', $row->id)->where('status', 'synced')
            ->where(fn ($q) => $q->whereNull('review_status')->orWhereIn('review_status', ['approved', 'limited']))->count();

        return number_format($live).' of '.number_format($total).' products live';
    }
}
