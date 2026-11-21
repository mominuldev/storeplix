<?php

namespace App\Domain\Identity\Models;

use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

/**
 * Platform-level identity. A user may belong to many tenants (tenant_users).
 *
 * @property string $id
 * @property string $name
 * @property string $email
 * @property string|null $phone
 */
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, HasUlids, Notifiable;

    protected $fillable = ['name', 'email', 'phone', 'password'];

    protected $hidden = ['password', 'remember_token'];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
        ];
    }

    public function tenants(): BelongsToMany
    {
        return $this->belongsToMany(Tenant::class, 'tenant_users')
            ->using(TenantUser::class)
            ->withPivot(['id', 'role'])
            ->withTimestamps();
    }

    /** Role of this user in the given tenant, or null when not a member. */
    public function roleIn(string $tenantId): ?string
    {
        return TenantUser::query()
            ->where('tenant_id', $tenantId)
            ->where('user_id', $this->getKey())
            ->value('role');
    }

    protected static function newFactory(): UserFactory
    {
        return UserFactory::new();
    }
}
