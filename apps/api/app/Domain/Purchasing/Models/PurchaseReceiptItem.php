<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One line of a receipt (PHASE-8-8B §3): quantities plus the cost trail (landed unit cost, cost before/after, on hand
 * before) so every cost change is explainable (P88B-5).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $purchase_receipt_id
 * @property string $purchase_order_item_id
 * @property string $variant_id
 * @property int $quantity_received
 * @property int $quantity_damaged
 * @property int $landed_unit_cost_amount
 * @property int|null $cost_before_amount
 * @property int|null $cost_after_amount
 * @property int $on_hand_before
 * @property Carbon $created_at
 */
class PurchaseReceiptItem extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'quantity_received' => 'integer',
            'quantity_damaged' => 'integer',
            'landed_unit_cost_amount' => 'integer',
            'cost_before_amount' => 'integer',
            'cost_after_amount' => 'integer',
            'on_hand_before' => 'integer',
        ];
    }
}
