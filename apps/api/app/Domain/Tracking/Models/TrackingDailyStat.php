<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9D §5.7: per integration / store-timezone day / canonical event counters (written by TrackingStats only).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $store_integration_id
 * @property Carbon $date
 * @property string $event_name
 * @property int $browser_count
 * @property int $server_sent
 * @property int $server_failed
 * @property int $server_skipped
 * @property Carbon|null $last_at
 */
class TrackingDailyStat extends Model
{
    use BelongsToTenant, HasUlids;

    public $timestamps = false;

    protected $table = 'tracking_daily_stats';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['date' => 'date', 'browser_count' => 'integer', 'server_sent' => 'integer', 'server_failed' => 'integer', 'server_skipped' => 'integer', 'last_at' => 'datetime'];
    }
}
