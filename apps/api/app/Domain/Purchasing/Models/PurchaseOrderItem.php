<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Models;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One line of a purchase order (one variant, PHASE-8-8B §3). "Left" = ordered − received − damaged (Q213).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $purchase_order_id
 * @property string $variant_id
 * @property int $unit_cost_amount
 * @property int $quantity_ordered
 * @property int $quantity_received
 * @property int $quantity_damaged
 * @property int $position
 * @property-read ProductVariant|null $variant
 */
class PurchaseOrderItem extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'unit_cost_amount' => 'integer',
            'quantity_ordered' => 'integer',
            'quantity_received' => 'integer',
            'quantity_damaged' => 'integer',
            'position' => 'integer',
        ];
    }

    public function left(): int
    {
        return max(0, $this->quantity_ordered - $this->quantity_received - $this->quantity_damaged);
    }

    public function lineValue(): int
    {
        return $this->unit_cost_amount * $this->quantity_ordered;
    }

    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'variant_id')->withTrashed();
    }

    public function purchaseOrder(): BelongsTo
    {
        return $this->belongsTo(PurchaseOrder::class);
    }
}
