<?php

namespace App\Domain\Identity\Models;

use App\Domain\Identity\Mail\ResetPasswordMail;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Mail;

/**
 * Platform-level identity. A user may belong to many tenants (tenant_users).
 *
 * @property string $id
 * @property string $name
 * @property string $email
 * @property string|null $phone 8801XXXXXXXXX
 * @property Carbon|null $phone_verified_at
 * @property Carbon|null $password_changed_at
 * @property string|null $platform_role PHASE-8-1 P8-2 (App\Domain\Admin\Authorization\PlatformRole)
 * @property Carbon|null $platform_disabled_at
 * @property Carbon|null $platform_locked_until
 * @property string|null $totp_secret encrypted
 * @property Carbon|null $totp_confirmed_at
 * @property int|null $totp_last_step
 */
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasFactory, HasUlids, Notifiable;

    protected $fillable = ['name', 'email', 'phone', 'password', 'email_verified_at', 'phone_verified_at', 'password_changed_at'];

    protected $hidden = ['password', 'remember_token', 'totp_secret', 'totp_last_step'];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'phone_verified_at' => 'datetime',
            'password_changed_at' => 'datetime',
            'password' => 'hashed',
            'platform_disabled_at' => 'datetime',
            'platform_locked_until' => 'datetime',
            'totp_secret' => 'encrypted',
            'totp_confirmed_at' => 'datetime',
            'totp_last_step' => 'integer',
        ];
    }

    public function tenants(): BelongsToMany
    {
        return $this->belongsToMany(Tenant::class, 'tenant_users')
            ->using(TenantUser::class)
            ->withPivot(['id', 'role', 'joined_at'])
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

    /** Password broker hook: queue our mailable instead of the default notification. */
    public function sendPasswordResetNotification($token): void
    {
        Mail::to($this->email)->queue(new ResetPasswordMail($this->email, $token));
    }

    protected static function newFactory(): UserFactory
    {
        return UserFactory::new();
    }
}
