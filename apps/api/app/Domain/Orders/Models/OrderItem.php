<?php

namespace App\Domain\Orders\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;

/**
 * Order line snapshot (P5-31). unit_cost_amount is never exposed to staff or the storefront.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $order_id
 * @property string|null $product_id
 * @property string|null $variant_id
 * @property string $product_name
 * @property string $variant_title
 * @property list<string> $option_values
 * @property string|null $sku
 * @property string|null $image_media_id
 * @property int $unit_price_amount
 * @property int|null $compare_at_amount
 * @property int|null $unit_cost_amount
 * @property int $subtotal_amount
 * @property int $discount_amount
 * @property int $total_amount
 * @property int $quantity
 * @property bool $tracked
 * @property string|null $location_id stock location the line committed at (PHASE-8-8C P88C-4; null = untracked)
 * @property int $restocked_quantity
 * @property int $position
 */
class OrderItem extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected $attributes = ['option_values' => '[]', 'discount_amount' => 0, 'restocked_quantity' => 0, 'position' => 0];

    protected function casts(): array
    {
        return [
            'option_values' => 'array',
            'unit_price_amount' => 'integer',
            'compare_at_amount' => 'integer',
            'unit_cost_amount' => 'integer',
            'subtotal_amount' => 'integer',
            'discount_amount' => 'integer',
            'total_amount' => 'integer',
            'quantity' => 'integer',
            'tracked' => 'boolean',
            'restocked_quantity' => 'integer',
            'position' => 'integer',
        ];
    }
}
