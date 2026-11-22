<?php

namespace App\Domain\Shared\Idempotency;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Stored Idempotency-Key (P5-14). The response body is encrypted at rest (it can carry a confirmation token).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $scope
 * @property string $key
 * @property string $request_hash
 * @property string $status
 * @property int|null $response_status
 * @property string|null $response_body
 * @property Carbon $locked_until
 * @property Carbon $created_at
 * @property Carbon $expires_at
 */
class IdempotencyKey extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    public const PROCESSING = 'processing';

    public const COMPLETED = 'completed';

    protected $fillable = [];

    protected $hidden = ['response_body'];

    protected function casts(): array
    {
        return [
            'response_status' => 'integer',
            'response_body' => 'encrypted',
            'locked_until' => 'datetime',
            'created_at' => 'datetime',
            'expires_at' => 'datetime',
        ];
    }
}
