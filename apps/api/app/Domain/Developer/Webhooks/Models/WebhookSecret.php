<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * The store's signing secret (P84-7, one per store). Both secrets are IntegrationCredentials ciphertext (S109) and
 * hidden from every serialisation; only WebhookSecrets reads them. Nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $secret_encrypted
 * @property string $last_four
 * @property string|null $previous_secret_encrypted
 * @property Carbon|null $previous_expires_at
 * @property Carbon|null $rotated_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class WebhookSecret extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected $hidden = ['secret_encrypted', 'previous_secret_encrypted'];

    protected function casts(): array
    {
        return [
            'previous_expires_at' => 'datetime',
            'rotated_at' => 'datetime',
        ];
    }
}
