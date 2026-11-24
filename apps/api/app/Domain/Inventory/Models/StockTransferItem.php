<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Models;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One line of a stock transfer (PHASE-8-8C §3.2): one variant, 1–100,000 units; `quantity_received` is set at receive
 * (≤ quantity; the rest is short).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $stock_transfer_id
 * @property string $variant_id
 * @property int $quantity
 * @property int|null $quantity_received
 * @property int $position
 * @property-read ProductVariant|null $variant
 */
class StockTransferItem extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['quantity' => 'integer', 'quantity_received' => 'integer', 'position' => 'integer'];
    }

    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'variant_id')->withTrashed();
    }
}
