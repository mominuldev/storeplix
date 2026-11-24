<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Models;

use App\Domain\Catalog\Models\Category;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A stock count of one location (PHASE-8-8C §3.2, §8, P88C-11). Store-scoped [S]; one `in_progress` count per location
 * (partial unique index). Written only by StockCountService; stock changes only through InventoryService::applyCount.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $location_id
 * @property string $name
 * @property string|null $category_id
 * @property string $status
 * @property bool|null $zero_uncounted
 * @property int $lines_count
 * @property int $counted_count
 * @property string|null $started_by
 * @property Carbon $started_at
 * @property string|null $finished_by
 * @property Carbon|null $finished_at
 * @property Carbon|null $cancelled_at
 * @property string|null $cancelled_by
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Location $location
 * @property-read Category|null $category
 */
class StockCount extends Model
{
    use BelongsToTenant, HasUlids;

    public const IN_PROGRESS = 'in_progress';

    public const COMPLETED = 'completed';

    public const CANCELLED = 'cancelled';

    public const STATUSES = [self::IN_PROGRESS, self::COMPLETED, self::CANCELLED];

    public const MAX_LINES = 5000;

    public const MAX_COUNTED = 1000000;

    protected $fillable = [];

    protected $attributes = ['status' => self::IN_PROGRESS, 'lines_count' => 0, 'counted_count' => 0, 'revision' => 1];

    protected function casts(): array
    {
        return [
            'zero_uncounted' => 'boolean', 'lines_count' => 'integer', 'counted_count' => 'integer', 'revision' => 'integer',
            'started_at' => 'datetime', 'finished_at' => 'datetime', 'cancelled_at' => 'datetime',
        ];
    }

    public function location(): BelongsTo
    {
        return $this->belongsTo(Location::class, 'location_id');
    }

    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class, 'category_id');
    }

    public function startedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'started_by');
    }

    public function finishedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'finished_by');
    }
}
