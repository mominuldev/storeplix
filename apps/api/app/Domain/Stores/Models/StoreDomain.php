<?php

namespace App\Domain\Stores\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $hostname
 * @property string $type
 * @property string $status
 * @property bool $is_primary
 * @property string|null $verification_token
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

    protected $fillable = ['store_id', 'hostname', 'type', 'status', 'is_primary', 'verification_token', 'verified_at'];

    protected $hidden = ['verification_token'];

    protected function casts(): array
    {
        return [
            'is_primary' => 'boolean',
            'verified_at' => 'datetime',
        ];
    }

    /** Hostnames are always stored normalized. */
    public function setHostnameAttribute(string $value): void
    {
        $this->attributes['hostname'] = strtolower(rtrim(trim($value), '.'));
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }
}
