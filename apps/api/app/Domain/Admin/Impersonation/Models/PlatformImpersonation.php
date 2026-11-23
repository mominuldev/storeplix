<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-1 P8-9 – P8-11, §5.1: one read-only impersonation (ticket → session). Platform table: no `tenant_id` column
 * on purpose, so it is not under RLS and the app role can read it during an impersonated merchant request.
 *
 * @property string $id
 * @property string $staff_user_id
 * @property string $target_tenant_id
 * @property string $reason
 * @property string|null $ticket_ref
 * @property string $ticket_hash
 * @property string $status
 * @property Carbon $ticket_expires_at
 * @property Carbon|null $started_at
 * @property Carbon|null $expires_at
 * @property Carbon|null $ended_at
 * @property string|null $ended_by
 * @property int $request_count
 * @property Carbon|null $last_request_at
 * @property string|null $ip
 * @property string|null $user_agent
 * @property Carbon|null $created_at
 * @property-read User|null $staff
 * @property-read Tenant|null $tenant
 */
class PlatformImpersonation extends Model
{
    use HasUlids;

    public const PENDING = 'pending';

    public const ACTIVE = 'active';

    public const ENDED = 'ended';

    public const EXPIRED = 'expired';

    public const STATUSES = [self::PENDING, self::ACTIVE, self::ENDED, self::EXPIRED];

    public const ENDED_BY_STAFF = 'staff';

    public const ENDED_BY_EXPIRY = 'expiry';

    public const ENDED_BY_REVOKED = 'revoked';

    protected $table = 'platform_impersonations';

    protected $fillable = [
        'staff_user_id', 'target_tenant_id', 'reason', 'ticket_ref', 'ticket_hash', 'status', 'ticket_expires_at',
        'started_at', 'expires_at', 'ended_at', 'ended_by', 'request_count', 'last_request_at', 'ip', 'user_agent',
    ];

    protected $hidden = ['ticket_hash'];

    protected $attributes = ['status' => self::PENDING, 'request_count' => 0];

    protected function casts(): array
    {
        return [
            'ticket_expires_at' => 'datetime',
            'started_at' => 'datetime',
            'expires_at' => 'datetime',
            'ended_at' => 'datetime',
            'last_request_at' => 'datetime',
            'request_count' => 'integer',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function staff(): BelongsTo
    {
        return $this->belongsTo(User::class, 'staff_user_id');
    }

    /** @return BelongsTo<Tenant, $this> */
    public function tenant(): BelongsTo
    {
        return $this->belongsTo(Tenant::class, 'target_tenant_id');
    }

    public function isLive(): bool
    {
        return $this->status === self::ACTIVE && $this->expires_at !== null && $this->expires_at->isFuture();
    }
}
