<?php

namespace App\Domain\Catalog\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Relations\Pivot;

/**
 * product_categories pivot (PK product_id + category_id). Tenant-scoped like every other tenant table.
 * Rows are written by CatalogPivots (explicit tenant_id/store_id), never by mass assignment.
 *
 * @property string $tenant_id
 * @property string $store_id
 * @property string $product_id
 * @property string $category_id
 * @property int $position
 */
class ProductCategory extends Pivot
{
    use BelongsToTenant;

    protected $table = 'product_categories';

    public $timestamps = false;

    public $incrementing = false;

    protected $fillable = ['position'];

    protected function casts(): array
    {
        return ['position' => 'integer'];
    }
}
