<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Models;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One count line (PHASE-8-8C §3.2): `counted` null = not counted yet; `expected` = the location's on_hand when the line
 * was (last) counted; `applied_delta` = what finish applied (null when nothing).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $stock_count_id
 * @property string $variant_id
 * @property int|null $counted
 * @property int|null $expected
 * @property Carbon|null $counted_at
 * @property string|null $counted_by
 * @property int|null $applied_delta
 * @property-read ProductVariant|null $variant
 */
class StockCountItem extends Model
{
    use BelongsToTenant, HasUlids;

    public $timestamps = false;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['counted' => 'integer', 'expected' => 'integer', 'applied_delta' => 'integer', 'counted_at' => 'datetime'];
    }

    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'variant_id')->withTrashed();
    }

    public function countedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'counted_by');
    }
}
