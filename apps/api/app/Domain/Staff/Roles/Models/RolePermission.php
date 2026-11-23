<?php

declare(strict_types=1);

namespace App\Domain\Staff\Roles\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One permission key of a CUSTOM role (P83-2; system roles never have rows, and rows of a system role are ignored).
 * PK (tenant_id, role_id, permission); written only by RoleService (delete + insert per change).
 *
 * @property string $tenant_id
 * @property string $role_id
 * @property string $permission
 * @property Carbon $created_at
 */
class RolePermission extends Model
{
    use BelongsToTenant;

    public const UPDATED_AT = null;

    public $incrementing = false;

    protected $primaryKey = 'role_id';

    protected $keyType = 'string';

    protected $fillable = ['role_id', 'permission'];
}
