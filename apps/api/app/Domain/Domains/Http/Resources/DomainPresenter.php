<?php

declare(strict_types=1);

namespace App\Domain\Domains\Http\Resources;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Domains\HostnameInput;
use App\Domain\Domains\Providers\ProviderHostname;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Carbon\CarbonImmutable;
use Carbon\CarbonInterface;

/**
 * StoreDomain / DomainListMeta in @storeplix/types (PHASE-6 §6). Never exposes provider ids, raw provider statuses,
 * resolver outcomes or (outside dns_records) the verification token.
 */
final class DomainPresenter
{
    /**
     * @param  array{manage: bool, feature: bool, store_suspended: bool}  $ctx
     * @return array<string, mixed>
     */
    public static function present(StoreDomain $d, array $ctx): array
    {
        $custom = $d->isCustom();
        $registrable = $custom ? HostnameInput::registrableFor($d->hostname) : $d->hostname;

        return [
            'id' => $d->id,
            'hostname' => $d->hostname,
            'display_hostname' => $d->display_hostname ?: HostnameInput::display($d->hostname),
            'type' => $d->type,
            'status' => $d->status,
            'is_primary' => (bool) $d->is_primary,
            'is_apex' => $custom && $d->hostname === $registrable,
            'routable' => $d->status === StoreDomain::STATUS_ACTIVE && ! $ctx['store_suspended'],
            'dns_records' => $custom ? self::dnsRecords($d, $registrable) : [],
            'ssl_status' => self::sslStatus($d),
            'verification_started_at' => self::ts($d->verification_started_at),
            'verified_at' => self::ts($d->verified_at),
            'activated_at' => self::ts($d->activated_at),
            'status_changed_at' => self::ts($d->status_changed_at),
            'last_checked_at' => self::ts($d->last_checked_at),
            'next_check_at' => self::ts($d->next_check_at),
            'deadline_at' => self::ts(self::deadline($d)),
            'failure_code' => $d->failure_code,
            'failure_message' => $d->failure_message,
            'can_recheck' => $ctx['manage'] && $custom && $d->status !== StoreDomain::STATUS_SUSPENDED,
            'can_make_primary' => $ctx['manage'] && $d->status === StoreDomain::STATUS_ACTIVE && ! $d->is_primary && ($ctx['feature'] || ! $custom),
            'can_remove' => $ctx['manage'] && $custom,
            'created_at' => self::ts($d->created_at),
            'updated_at' => self::ts($d->updated_at),
        ];
    }

    /**
     * Role + plan context of the current request (call inside the tenant).
     *
     * @return array{manage: bool, feature: bool, store_suspended: bool}
     */
    public static function context(Store $store, bool $manage = true): array
    {
        $context = app(TenantContext::class);
        $tenant = $context->tenant();

        return [
            'manage' => $manage && $context->allows(Permission::DomainsManage),
            'feature' => $tenant !== null && FeatureGate::allows($tenant, Feature::CustomDomain),
            'store_suspended' => $store->status === Store::STATUS_SUSPENDED,
        ];
    }

    /** @return array<string, mixed> DomainListMeta */
    public static function meta(Store $store, array $ctx): array
    {
        $tenant = app(TenantContext::class)->tenant();
        $used = $tenant !== null ? FeatureGate::usage($tenant, Limit::CustomDomains) : 0;
        $max = $tenant !== null ? FeatureGate::limit($tenant, Limit::CustomDomains) : 0;

        return [
            'cname_target' => (string) config('domains.cname_target'),
            'txt_prefix' => (string) config('domains.txt_prefix'),
            'can_add' => $ctx['manage'] && $ctx['feature'] && ($max === null || $used < $max),
            'feature_enabled' => $ctx['feature'],
            'limit' => ['used' => $used, 'max' => $max],
        ];
    }

    /** @return list<array<string, mixed>> ownership (TXT) + routing (CNAME) records with the last observed status */
    public static function dnsRecords(StoreDomain $d, string $registrable): array
    {
        $txtName = config('domains.txt_prefix').'.'.$d->hostname;
        $records = is_array($d->last_check['records'] ?? null) ? $d->last_check['records'] : [];

        return [
            [
                'purpose' => 'ownership',
                'type' => 'TXT',
                'name' => $txtName,
                'name_relative' => self::relative($txtName, $registrable),
                'value' => 'sp-verify='.$d->verification_token,
                ...self::observed($records['ownership'] ?? null),
            ],
            [
                'purpose' => 'routing',
                'type' => 'CNAME',
                'name' => $d->hostname,
                'name_relative' => self::relative($d->hostname, $registrable),
                'value' => (string) config('domains.cname_target'),
                ...self::observed($records['routing'] ?? null),
            ],
        ];
    }

    public static function sslStatus(StoreDomain $d): string
    {
        if ($d->isPlatform()) {
            return 'active';
        }
        if ($d->provider_hostname_id === null) {
            return 'none';
        }

        return match (ProviderHostname::mapSsl($d->ssl_status)) {
            ProviderHostname::ACTIVE => 'active',
            ProviderHostname::FAILED => 'failed',
            default => 'pending',
        };
    }

    /** The 72 h / 24 h / 7-day deadline that applies now (§6). */
    public static function deadline(StoreDomain $d): ?CarbonImmutable
    {
        $at = fn (?CarbonInterface $start, int $hours) => $start === null ? null : CarbonImmutable::instance($start)->addHours($hours);
        $ssl = (int) config('domains.ssl_window_hours', 24);

        return match ($d->status) {
            StoreDomain::STATUS_PENDING_VERIFICATION => $at($d->verification_started_at, (int) config('domains.verify_window_hours', 72)),
            StoreDomain::STATUS_VERIFIED => $at($d->verified_at ?? $d->status_changed_at, $ssl),
            StoreDomain::STATUS_SSL_PROVISIONING => $at($d->status_changed_at, $ssl),
            StoreDomain::STATUS_ACTIVE => $at($d->first_failed_at, 24 * (int) config('domains.expire_after_days', 7)),
            default => null,
        };
    }

    private static function relative(string $name, string $registrable): string
    {
        if ($name === $registrable) {
            return '@';
        }

        return str_ends_with($name, '.'.$registrable) ? substr($name, 0, -strlen('.'.$registrable)) : $name;
    }

    /** @return array{status: string, found: list<string>} */
    private static function observed(mixed $record): array
    {
        $status = is_array($record) ? (string) ($record['status'] ?? 'pending') : 'pending';
        if (! in_array($status, ['ok', 'missing', 'mismatch'], true)) {
            $status = 'pending';
        }
        $found = is_array($record) ? array_slice(array_values(array_map('strval', (array) ($record['found'] ?? []))), 0, 5) : [];

        return ['status' => $status, 'found' => array_map(fn ($v) => mb_substr($v, 0, 255), $found)];
    }

    private static function ts(?CarbonInterface $at): ?string
    {
        return $at?->toIso8601ZuluString();
    }
}
