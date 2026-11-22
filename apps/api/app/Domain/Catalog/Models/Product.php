<?php

namespace App\Domain\Catalog\Models;

use App\Domain\Identity\Models\User;
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
 * Product (P4-1..P4-12). Price and stock live on variants; only the enabled-variant price range is denormalised.
 * Derived/locked columns (price_*_amount, revision, published_at) are never mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $name
 * @property string $slug
 * @property string $type
 * @property string $status
 * @property array<string, mixed>|null $description
 * @property list<array{name: string, values: list<string>}> $options
 * @property list<string> $tags
 * @property string|null $seo_title
 * @property string|null $seo_description
 * @property string $currency
 * @property int $price_min_amount
 * @property int $price_max_amount
 * @property int $revision
 * @property Carbon|null $published_at
 * @property string|null $created_by
 * @property string|null $updated_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property Carbon|null $deleted_at
 */
class Product extends Model
{
    use BelongsToTenant, HasUlids, SoftDeletes;

    public const DRAFT = 'draft';

    public const ACTIVE = 'active';

    public const ARCHIVED = 'archived';

    public const STATUSES = [self::DRAFT, self::ACTIVE, self::ARCHIVED];

    public const SIMPLE = 'simple';

    public const VARIABLE = 'variable';

    public const SLUG_PATTERN = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/';

    public const MAX_OPTIONS = 3;

    public const MAX_OPTION_VALUES = 20;

    public const MAX_VARIANTS = 100;

    public const MAX_IMAGES = 10;

    public const MAX_CATEGORIES = 10;

    public const MAX_TAGS = 20;

    public const MAX_AMOUNT = 1_000_000_000;

    public const DESCRIPTION_MAX_BYTES = 20_480;

    protected $fillable = ['name', 'slug', 'type', 'status', 'description', 'options', 'tags', 'seo_title', 'seo_description', 'currency', 'created_by', 'updated_by'];

    protected $attributes = ['status' => self::DRAFT, 'options' => '[]', 'tags' => '[]', 'revision' => 1, 'price_min_amount' => 0, 'price_max_amount' => 0];

    protected function casts(): array
    {
        return [
            'description' => 'array',
            'options' => 'array',
            'tags' => 'array',
            'price_min_amount' => 'integer',
            'price_max_amount' => 'integer',
            'revision' => 'integer',
            'published_at' => 'datetime',
        ];
    }

    public function isActive(): bool
    {
        return $this->status === self::ACTIVE;
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function variants(): HasMany
    {
        return $this->hasMany(ProductVariant::class)->orderBy('position')->orderBy('id');
    }

    public function images(): HasMany
    {
        return $this->hasMany(ProductImage::class)->orderBy('position');
    }

    public function categories(): BelongsToMany
    {
        return $this->belongsToMany(Category::class, 'product_categories')->using(ProductCategory::class)
            ->withPivot('position')->orderBy('product_categories.position');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function updatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }
}
