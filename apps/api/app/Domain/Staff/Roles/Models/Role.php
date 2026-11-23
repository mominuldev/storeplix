<?php

declare(strict_types=1);

namespace App\Domain\Staff\Roles\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-3 §5.1 / ADR 0017: a tenant role. System roles (`key` owner|admin|staff, `is_system`) take their permissions
 * from SystemRole (code); custom roles (`key` null) from `role_permissions`. Resolve permissions with RolePermissions.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string|null $key
 * @property string $name
 * @property string|null $description
 * @property bool $is_system
 * @property int $revision
 * @property string|null $created_by
 * @property string|null $updated_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read User|null $editor
 */
class Role extends Model
{
    use BelongsToTenant, HasUlids;

    public const MAX_NAME = 40;

    public const MAX_DESCRIPTION = 200;

    protected $fillable = ['key', 'name', 'description', 'is_system', 'revision', 'created_by', 'updated_by'];

    protected $attributes = ['revision' => 1, 'is_system' => false];

    protected function casts(): array
    {
        return ['is_system' => 'boolean', 'revision' => 'integer'];
    }

    public function systemRole(): ?SystemRole
    {
        return $this->is_system && $this->key !== null ? SystemRole::tryFrom($this->key) : null;
    }

    /** Value of tenant_users.role / staff_invitations.role for members of this role (P83-3). */
    public function kind(): string
    {
        return $this->systemRole()?->value ?? 'custom';
    }

    public function isOwner(): bool
    {
        return $this->systemRole() === SystemRole::Owner;
    }

    public function permissionRows(): HasMany
    {
        return $this->hasMany(RolePermission::class, 'role_id');
    }

    public function editor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }
}
