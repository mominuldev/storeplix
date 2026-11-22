<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A bulk booking run (P5B-40). `results` = list of `{order_id, order_number, shipment_id, status, reason}` (types
 * ShipmentBatch.results; booked | skipped | failed).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $provider
 * @property string $status
 * @property int $total
 * @property int $booked
 * @property int $skipped
 * @property int $failed
 * @property list<array<string, mixed>> $results
 * @property string|null $created_by
 * @property Carbon|null $started_at
 * @property Carbon|null $finished_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class ShipmentBatch extends Model
{
    use BelongsToTenant, HasUlids;

    public const QUEUED = 'queued';

    public const RUNNING = 'running';

    public const COMPLETED = 'completed';

    public const FAILED = 'failed';

    public const STATUSES = [self::QUEUED, self::RUNNING, self::COMPLETED, self::FAILED];

    protected $fillable = [];

    protected $attributes = ['status' => self::QUEUED, 'total' => 0, 'booked' => 0, 'skipped' => 0, 'failed' => 0, 'results' => '[]'];

    protected function casts(): array
    {
        return [
            'results' => 'array',
            'total' => 'integer',
            'booked' => 'integer',
            'skipped' => 'integer',
            'failed' => 'integer',
            'started_at' => 'datetime',
            'finished_at' => 'datetime',
        ];
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
