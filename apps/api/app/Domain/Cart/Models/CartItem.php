<?php

namespace App\Domain\Cart\Models;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $cart_id
 * @property string $variant_id
 * @property int $quantity
 * @property-read ProductVariant|null $variant
 */
class CartItem extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['quantity' => 'integer'];
    }

    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'variant_id')->withTrashed();
    }
}
