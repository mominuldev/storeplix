<?php

declare(strict_types=1);

namespace App\Domain\Developer\ApiKeys\Models;

use App\Domain\Developer\ApiKeys\ApiScope;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-4 §5.1 (P84-2): a tenant-level API key. Only `key_hash` (sha256 hex of the plain key) is stored; the plain
 * key is returned once by ApiKeyService::create and never again. Revoking keeps the row (`revoked_at`).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $name
 * @property string $prefix
 * @property string $last_four
 * @property string $key_hash
 * @property list<string> $scopes
 * @property bool $include_costs
 * @property string|null $created_by_user_id
 * @property Carbon|null $last_used_at
 * @property Carbon|null $revoked_at
 * @property string|null $revoked_by_user_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read User|null $creator
 */
class ApiKey extends Model
{
    use BelongsToTenant, HasUlids;

    public const PLAIN_PREFIX = 'sp_live_';

    public const PLAIN_PATTERN = '/^sp_live_[A-Za-z0-9]{40}$/';

    public const MAX_NAME = 60;

    /** P84-14 */
    public const MAX_ACTIVE = 10;

    /** §6.1: revoked keys stay listed for 90 days. */
    public const REVOKED_LISTED_DAYS = 90;

    protected $table = 'api_keys';

    /** key_hash is never serialised. */
    protected $hidden = ['key_hash'];

    protected function casts(): array
    {
        return [
            'scopes' => 'array',
            'include_costs' => 'boolean',
            'last_used_at' => 'datetime',
            'revoked_at' => 'datetime',
        ];
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by_user_id');
    }

    public function isRevoked(): bool
    {
        return $this->revoked_at !== null;
    }

    /** @return list<ApiScope> */
    public function grantedScopes(): array
    {
        return ApiScope::fromStored($this->scopes ?? []);
    }

    public function hasScope(ApiScope $scope): bool
    {
        return in_array($scope, $this->grantedScopes(), true);
    }

    /** "sp_live_••••7f2a" */
    public function masked(): string
    {
        return self::PLAIN_PREFIX.'••••'.$this->last_four;
    }

    /** @param Builder<self> $query */
    public function scopeActive(Builder $query): void
    {
        $query->whereNull('revoked_at');
    }
}
