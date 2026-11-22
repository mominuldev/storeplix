<?php

declare(strict_types=1);

namespace App\Domain\Domains\Providers;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/** A provider custom hostname with the §5.2 status mapping (raw values kept for support). */
final readonly class ProviderHostname
{
    public const ACTIVE = 'active';

    public const PENDING = 'pending';

    public const BLOCKED = 'blocked';

    public const MOVED = 'moved';

    public const GONE = 'gone';

    public const FAILED = 'failed';

    /** Cloudflare hostname status → ours. `pending_*` and `test_*` prefixes are handled in hostnameState(). VERIFY. */
    public const HOSTNAME_STATES = [
        'active' => self::ACTIVE,
        'pending' => self::PENDING,
        'active_redeploying' => self::PENDING,
        'blocked' => self::BLOCKED,
        'pending_blocked' => self::BLOCKED,
        'moved' => self::MOVED,
        'deleted' => self::GONE,
        'pending_deletion' => self::GONE,
    ];

    /** Cloudflare SSL status → ours. `staging_*` prefixes are pending. VERIFY. */
    public const SSL_STATES = [
        'active' => self::ACTIVE,
        'initializing' => self::PENDING,
        'pending_validation' => self::PENDING,
        'pending_issuance' => self::PENDING,
        'pending_deployment' => self::PENDING,
        'holding_deployment' => self::PENDING,
        'backup_issued' => self::PENDING,
        'validation_timed_out' => self::FAILED,
        'issuance_timed_out' => self::FAILED,
        'deployment_timed_out' => self::FAILED,
        'initializing_timed_out' => self::FAILED,
        'expired' => self::FAILED,
        'deleted' => self::FAILED,
        'inactive' => self::FAILED,
        'deactivating' => self::FAILED,
    ];

    public function __construct(
        public string $id,
        public string $hostname,
        public string $status,
        public ?string $sslStatus,
        public ?string $createdAt = null,
    ) {}

    public function hostnameState(): string
    {
        return self::mapHostname($this->status);
    }

    public function sslState(): string
    {
        return self::mapSsl($this->sslStatus);
    }

    public function isLive(): bool
    {
        return $this->hostnameState() === self::ACTIVE && $this->sslState() === self::ACTIVE;
    }

    public static function mapHostname(?string $raw): string
    {
        $raw = strtolower((string) $raw);
        if (isset(self::HOSTNAME_STATES[$raw])) {
            return self::HOSTNAME_STATES[$raw];
        }
        if (str_starts_with($raw, 'pending_') || str_starts_with($raw, 'test_')) {
            return self::PENDING;
        }
        self::unknown('hostname', $raw);

        return self::PENDING;
    }

    public static function mapSsl(?string $raw): string
    {
        $raw = strtolower((string) $raw);
        if ($raw === '') {
            return self::PENDING;
        }
        if (isset(self::SSL_STATES[$raw])) {
            return self::SSL_STATES[$raw];
        }
        if (str_starts_with($raw, 'staging_')) {
            return self::PENDING;
        }
        self::unknown('ssl', $raw);

        return self::PENDING;
    }

    /** Unknown provider values map to pending and are logged once per value (per day). */
    private static function unknown(string $kind, string $raw): void
    {
        $value = substr(preg_replace('/[^a-z0-9_]/', '', $raw) ?? '', 0, 40);
        if (Cache::add("domains:unknown-status:{$kind}:{$value}", true, now()->addDay())) {
            Log::warning('domains.provider_unknown_status', ['kind' => $kind, 'value' => $value]);
        }
    }
}
