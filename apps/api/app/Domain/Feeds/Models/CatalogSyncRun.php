<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9D §3.1: one feed sync run.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $store_integration_id
 * @property string $kind
 * @property string $trigger
 * @property string $status
 * @property int $items_sent
 * @property int $items_failed
 * @property int $items_deleted
 * @property string|null $error_code
 * @property Carbon $started_at
 * @property Carbon|null $finished_at
 */
class CatalogSyncRun extends Model
{
    use BelongsToTenant, HasUlids;

    public const RUNNING = 'running';

    public const DONE = 'done';

    public const PARTIAL = 'partial';

    public const FAILED = 'failed';

    public $timestamps = false;

    protected $table = 'catalog_sync_runs';

    protected $fillable = [];

    /** Counters start at 0 in memory too (the sync increments them before the row is re-read). */
    protected $attributes = ['items_sent' => 0, 'items_failed' => 0, 'items_deleted' => 0];

    protected function casts(): array
    {
        return ['items_sent' => 'integer', 'items_failed' => 'integer', 'items_deleted' => 'integer', 'started_at' => 'datetime', 'finished_at' => 'datetime'];
    }
}
