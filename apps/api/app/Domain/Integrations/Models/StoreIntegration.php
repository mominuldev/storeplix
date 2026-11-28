<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Integrations\Casts\EncryptedCredentials;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9D §3.1: one integration of a store (P89D-3). `credentials` is IntegrationCredentials ciphertext (P89D-5),
 * hidden from every serialisation and never put in a job payload: jobs load the row by id. Nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $provider
 * @property string $status
 * @property array<string, mixed> $settings
 * @property array<string, mixed>|null $credentials
 * @property array<string, string> $credentials_hint
 * @property list<array{reason: string, count: int|null, since: string}> $attention
 * @property Carbon|null $token_expires_at
 * @property Carbon|null $last_verified_at
 * @property string|null $last_error_code
 * @property string|null $connected_by
 * @property Carbon|null $connected_at
 * @property Carbon|null $disconnected_at
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class StoreIntegration extends Model
{
    use BelongsToTenant, HasUlids;

    public const SETUP_REQUIRED = 'setup_required';

    public const CONNECTED = 'connected';

    public const NEEDS_ATTENTION = 'needs_attention';

    public const ERROR = 'error';

    public const DISCONNECTED = 'disconnected';

    /** Presented for providers without a row. */
    public const NOT_CONNECTED = 'not_connected';

    /** Statuses in which a tracker sends and a feed syncs. */
    public const ACTIVE = [self::CONNECTED, self::NEEDS_ATTENTION];

    protected $table = 'store_integrations';

    protected $fillable = [];

    protected $hidden = ['credentials'];

    protected function casts(): array
    {
        return [
            'settings' => 'array',
            'credentials' => EncryptedCredentials::class,
            'credentials_hint' => 'array',
            'attention' => 'array',
            'token_expires_at' => 'datetime',
            'last_verified_at' => 'datetime',
            'connected_at' => 'datetime',
            'disconnected_at' => 'datetime',
            'revision' => 'integer',
        ];
    }

    public function connectedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'connected_by');
    }

    public function isActive(): bool
    {
        return in_array($this->status, self::ACTIVE, true);
    }

    public function kind(): string
    {
        return IntegrationProvider::kind($this->provider);
    }

    /** @return list<string> */
    public function attentionReasons(): array
    {
        return array_values(array_map(fn (array $a) => (string) $a['reason'], $this->attention ?? []));
    }

    public function hasAttention(string $reason): bool
    {
        return in_array($reason, $this->attentionReasons(), true);
    }

    /** A setting with its default (stored settings are always complete; defaults cover older rows). */
    public function setting(string $key, mixed $default = null): mixed
    {
        return ($this->settings ?? [])[$key] ?? $default;
    }

    /** @return array<string, mixed> decrypted secrets (empty when none) — drivers only, never presented */
    public function secrets(): array
    {
        return $this->credentials ?? [];
    }
}
