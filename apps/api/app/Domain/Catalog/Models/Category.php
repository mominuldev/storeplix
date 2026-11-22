<?php

namespace App\Domain\Catalog\Models;

use App\Domain\Media\Models\Media;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Category tree node (P4-8). depth 1–3, siblings ordered by position.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string|null $parent_id
 * @property string $name
 * @property string $slug
 * @property string|null $description
 * @property string|null $image_media_id
 * @property int $depth
 * @property int $position
 * @property bool $is_visible
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Media|null $image
 */
class Category extends Model
{
    use BelongsToTenant, HasUlids, SoftDeletes;

    public const MAX_DEPTH = 3;

    public const MAX_PER_STORE = 500;

    public const SLUG_PATTERN = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/';

    protected $fillable = ['parent_id', 'name', 'slug', 'description', 'image_media_id', 'depth', 'position', 'is_visible', 'created_by', 'updated_by'];

    protected $attributes = ['is_visible' => true, 'position' => 0];

    protected function casts(): array
    {
        return ['depth' => 'integer', 'position' => 'integer', 'is_visible' => 'boolean'];
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function parent(): BelongsTo
    {
        return $this->belongsTo(self::class, 'parent_id');
    }

    public function children(): HasMany
    {
        return $this->hasMany(self::class, 'parent_id');
    }

    public function image(): BelongsTo
    {
        return $this->belongsTo(Media::class, 'image_media_id');
    }

    public function products(): BelongsToMany
    {
        return $this->belongsToMany(Product::class, 'product_categories')->using(ProductCategory::class)->withPivot('position');
    }
}
