<?php

namespace App\Domain\Returns\Models;

use App\Domain\Orders\Models\OrderItem;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A returned order line. amount = floor(line total × quantity / line quantity) (§8).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $return_request_id
 * @property string $order_item_id
 * @property int $quantity
 * @property string|null $exchange_variant_id
 * @property string|null $exchange_variant_title
 * @property int $restocked_quantity
 * @property int $amount
 * @property-read OrderItem|null $orderItem
 */
class ReturnItem extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected $attributes = ['restocked_quantity' => 0];

    protected function casts(): array
    {
        return ['quantity' => 'integer', 'restocked_quantity' => 'integer', 'amount' => 'integer'];
    }

    public function orderItem(): BelongsTo
    {
        return $this->belongsTo(OrderItem::class);
    }
}
