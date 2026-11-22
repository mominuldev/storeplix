<?php

namespace App\Domain\Stores\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $hostname
 * @property string|null $display_hostname
 * @property string $type
 * @property string $status
 * @property bool $is_primary
 * @property string|null $verification_token
 * @property Carbon|null $verified_at
 * @property Carbon|null $verification_started_at
 * @property Carbon|null $status_changed_at
 * @property Carbon|null $activated_at
 * @property Carbon|null $last_checked_at
 * @property Carbon|null $next_check_at
 * @property Carbon|null $first_failed_at
 * @property Carbon|null $unproven_since
 * @property int $check_attempts
 * @property string|null $failure_code
 * @property string|null $failure_message
 * @property array<string, mixed>|null $last_check
 * @property string|null $provider
 * @property string|null $provider_hostname_id
 * @property string|null $provider_status
 * @property string|null $ssl_status
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class StoreDomain extends Model
{
    use BelongsToTenant, HasUlids;

    public const TYPE_PLATFORM = 'platform';

    public const TYPE_CUSTOM = 'custom';

    // Mirrors DomainStatus in @storeplix/types.
    public const STATUS_PENDING_VERIFICATION = 'pending_verification';

    public const STATUS_VERIFICATION_FAILED = 'verification_failed';

    public const STATUS_VERIFIED = 'verified';

    public const STATUS_SSL_PROVISIONING = 'ssl_provisioning';

    public const STATUS_ACTIVE = 'active';

    public const STATUS_EXPIRED = 'expired';

    public const STATUS_SUSPENDED = 'suspended';

    public const STATUSES = [
        self::STATUS_PENDING_VERIFICATION, self::STATUS_VERIFICATION_FAILED, self::STATUS_VERIFIED,
        self::STATUS_SSL_PROVISIONING, self::STATUS_ACTIVE, self::STATUS_EXPIRED, self::STATUS_SUSPENDED,
    ];

    /**
     * Saves that change one of these are routing-relevant (P6-16): resolver cache + storefront revalidation.
     * Check bookkeeping (last_checked_at, next_check_at, last_check, counters, provider status) is not.
     */
    public const ROUTING_FIELDS = ['status', 'is_primary', 'hostname'];

    /**
     * Phase 6 (§3.1): input never reaches status, provider or timestamp fields. Custom rows are created by
     * DomainService and moved only by DomainStateMachine / DomainChecker (forceFill / conditional updates).
     */
    protected $fillable = ['store_id', 'hostname', 'type', 'status', 'is_primary', 'verification_token', 'verified_at'];

    protected $hidden = ['verification_token', 'provider_hostname_id', 'provider_status', 'last_check'];

    protected function casts(): array
    {
        return [
            'is_primary' => 'boolean',
            'verified_at' => 'datetime',
            'verification_started_at' => 'datetime',
            'status_changed_at' => 'datetime',
            'activated_at' => 'datetime',
            'last_checked_at' => 'datetime',
            'next_check_at' => 'datetime',
            'first_failed_at' => 'datetime',
            'unproven_since' => 'datetime',
            'check_attempts' => 'integer',
            'last_check' => 'array',
        ];
    }

    /** Hostnames are always stored normalized. */
    public function setHostnameAttribute(string $value): void
    {
        $this->attributes['hostname'] = strtolower(rtrim(trim($value), '.'));
    }

    public function isPlatform(): bool
    {
        return $this->type === self::TYPE_PLATFORM;
    }

    public function isCustom(): bool
    {
        return $this->type === self::TYPE_CUSTOM;
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }
}
