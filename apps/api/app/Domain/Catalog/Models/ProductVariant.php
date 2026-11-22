<?php

namespace App\Domain\Catalog\Models;

use App\Domain\Inventory\Models\Inventory;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $product_id
 * @property string $title
 * @property string $option1
 * @property string $option2
 * @property string $option3
 * @property string|null $sku
 * @property string|null $barcode
 * @property int $price_amount
 * @property int|null $compare_at_amount
 * @property int|null $cost_amount
 * @property int|null $weight_grams
 * @property int $position
 * @property bool $is_default
 * @property bool $is_enabled
 * @property bool $track_inventory
 * @property bool $allow_backorder
 * @property string|null $image_media_id
 * @property Carbon $updated_at
 * @property-read Product $product
 * @property-read Inventory|null $inventory
 */
class ProductVariant extends Model
{
    use BelongsToTenant, HasUlids, SoftDeletes;

    public const SKU_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/';

    public const BARCODE_PATTERN = '/^[A-Za-z0-9-]{1,64}$/';

    protected $fillable = [
        'title', 'option1', 'option2', 'option3', 'sku', 'barcode', 'price_amount', 'compare_at_amount', 'cost_amount',
        'weight_grams', 'position', 'is_default', 'is_enabled', 'track_inventory', 'allow_backorder', 'image_media_id',
    ];

    protected $attributes = [
        'option1' => '', 'option2' => '', 'option3' => '', 'position' => 0,
        'is_default' => false, 'is_enabled' => true, 'track_inventory' => true, 'allow_backorder' => false,
    ];

    protected function casts(): array
    {
        return [
            'price_amount' => 'integer',
            'compare_at_amount' => 'integer',
            'cost_amount' => 'integer',
            'weight_grams' => 'integer',
            'position' => 'integer',
            'is_default' => 'boolean',
            'is_enabled' => 'boolean',
            'track_inventory' => 'boolean',
            'allow_backorder' => 'boolean',
        ];
    }

    /** @return list<string> option values in Product.options order */
    public function optionValues(int $count): array
    {
        return array_slice([$this->option1, $this->option2, $this->option3], 0, $count);
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class)->withTrashed();
    }

    public function inventory(): HasOne
    {
        return $this->hasOne(Inventory::class, 'variant_id');
    }
}
