<?php

namespace App\Domain\Staff\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $email
 * @property string|null $name
 * @property string $role
 * @property string $token_hash
 * @property string $invited_by
 * @property Carbon $expires_at
 * @property Carbon|null $accepted_at
 * @property string|null $accepted_user_id
 * @property Carbon|null $revoked_at
 * @property Carbon $last_sent_at
 * @property-read User|null $inviter
 */
class StaffInvitation extends Model
{
    use BelongsToTenant, HasUlids;

    public const TTL_DAYS = 7;

    protected $fillable = ['email', 'name', 'role', 'token_hash', 'invited_by', 'expires_at', 'accepted_at', 'accepted_user_id', 'revoked_at', 'last_sent_at'];

    protected $hidden = ['token_hash'];

    protected function casts(): array
    {
        return [
            'expires_at' => 'datetime',
            'accepted_at' => 'datetime',
            'revoked_at' => 'datetime',
            'last_sent_at' => 'datetime',
        ];
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }

    /** 32 random bytes, base64url. Only the sha256 is stored. */
    public static function newToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public function inviter(): BelongsTo
    {
        return $this->belongsTo(User::class, 'invited_by');
    }

    /** Not accepted and not revoked (may be expired). */
    public function isOpen(): bool
    {
        return $this->accepted_at === null && $this->revoked_at === null;
    }

    public function isExpired(): bool
    {
        return $this->expires_at->isPast();
    }

    public function isUsable(): bool
    {
        return $this->isOpen() && ! $this->isExpired();
    }

    public function scopeOpen(Builder $query): Builder
    {
        return $query->whereNull('accepted_at')->whereNull('revoked_at');
    }

    public function scopePending(Builder $query): Builder
    {
        return $query->open()->where('expires_at', '>', now());
    }
}
