<?php

namespace App\Domain\Inventory\Models;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Stock level of one variant AT ONE LOCATION (PHASE-8-8C P88C-3: unique per variant × location; a missing row reads as
 * 0). on_hand AND committed change ONLY through InventoryService (P4-12, P5-5: committed = quantities of placed,
 * unshipped orders). Neither is mass-assignable. Readers are classified (P88C-6): online readers use
 * ProductVariant::inventory() / scopeOnline(), total readers InventorySql::totals(), location readers filter
 * location_id.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $variant_id
 * @property string $location_id
 * @property int $on_hand
 * @property int $committed
 * @property int|null $low_stock_threshold
 * @property Carbon $updated_at
 */
class Inventory extends Model
{
    use BelongsToTenant, HasUlids;

    public const DEFAULT_LOW_STOCK_THRESHOLD = 5;

    protected $fillable = ['low_stock_threshold'];

    protected $attributes = ['on_hand' => 0, 'committed' => 0];

    protected function casts(): array
    {
        return ['on_hand' => 'integer', 'committed' => 'integer', 'low_stock_threshold' => 'integer'];
    }

    /**
     * The online location's row (P88C-4): the store's default location. Correlated on the row's own store, so it is
     * also correct outside a tenant context (platform reads) and never needs a join.
     */
    public const ONLINE_SQL = 'inventories.location_id = (SELECT online_l.id FROM locations online_l WHERE online_l.store_id = inventories.store_id AND online_l.is_default = true)';

    /** @param Builder<Inventory> $query */
    public function scopeOnline(Builder $query): void
    {
        $query->whereRaw(self::ONLINE_SQL);
    }

    public function location(): BelongsTo
    {
        return $this->belongsTo(Location::class, 'location_id');
    }

    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'variant_id')->withTrashed();
    }

    public function available(): int
    {
        return $this->on_hand - $this->committed;
    }

    public function effectiveThreshold(): int
    {
        return $this->low_stock_threshold ?? self::DEFAULT_LOW_STOCK_THRESHOLD;
    }

    /** StockStatus (§3.3). */
    public static function status(bool $tracked, int $available, int $threshold): string
    {
        return match (true) {
            ! $tracked => 'untracked',
            $available <= 0 => 'out_of_stock',
            $available <= $threshold => 'low_stock',
            default => 'in_stock',
        };
    }
}
