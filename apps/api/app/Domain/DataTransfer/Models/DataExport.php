<?php

namespace App\Domain\DataTransfer\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $type
 * @property string $status
 * @property array<string, mixed> $filters
 * @property string|null $file_path
 * @property int|null $row_count
 * @property bool $include_costs
 * @property Carbon|null $expires_at
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property-read User|null $createdBy
 */
class DataExport extends Model
{
    use BelongsToTenant, HasUlids;

    public const QUEUED = 'queued';

    public const RUNNING = 'running';

    public const COMPLETED = 'completed';

    public const FAILED = 'failed';

    public const EXPIRED = 'expired';

    public const TTL_HOURS = 24;

    protected $fillable = ['type', 'status', 'filters', 'file_path', 'row_count', 'expires_at', 'created_by'];

    /** Not fillable: set only by ExportController from the requester's `costs.view` (SEC-M1). */
    protected function casts(): array
    {
        return ['filters' => 'array', 'row_count' => 'integer', 'expires_at' => 'datetime', 'include_costs' => 'boolean'];
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
