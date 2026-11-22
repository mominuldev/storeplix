<?php

namespace App\Domain\Inventory\Models;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Stock level of one variant (single location). on_hand changes ONLY through InventoryService (P4-12);
 * committed is never written in Phase 4. Neither is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $variant_id
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
