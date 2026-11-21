<?php

namespace App\Domain\Tenancy\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Relations\Pivot;

/**
 * Membership of a user in a tenant. Platform-level: it is how a tenant gets resolved
 * for a user, so it cannot itself depend on a tenant context.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $user_id
 * @property string $role
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

    protected $fillable = ['tenant_id', 'user_id', 'role'];
}
