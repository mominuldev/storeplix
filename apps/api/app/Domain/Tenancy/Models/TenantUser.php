<?php

namespace App\Domain\Tenancy\Models;

use App\Domain\Identity\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\Pivot;
use Illuminate\Support\Carbon;

/**
 * Membership of a user in a tenant. Platform-level: it is how a tenant gets resolved
 * for a user, so it cannot itself depend on a tenant context.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $user_id
 * @property string $role
 * @property string|null $invited_by
 * @property Carbon|null $joined_at
 */
class TenantUser extends Pivot
{
    use HasUlids;

    public const ROLE_OWNER = 'owner';

    public const ROLE_ADMIN = 'admin';

    public const ROLE_STAFF = 'staff';

    public const ROLES = [self::ROLE_OWNER, self::ROLE_ADMIN, self::ROLE_STAFF];

    protected $table = 'tenant_users';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['tenant_id', 'user_id', 'role', 'invited_by', 'joined_at'];

    protected function casts(): array
    {
        return ['joined_at' => 'datetime'];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function inviter(): BelongsTo
    {
        return $this->belongsTo(User::class, 'invited_by');
    }

    /** Explicit tenant filter (membership is platform-level, so no global scope). */
    public function scopeForTenant(Builder $query, string $tenantId): Builder
    {
        return $query->where('tenant_id', $tenantId);
    }
}
