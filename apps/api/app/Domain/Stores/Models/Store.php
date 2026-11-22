<?php

namespace App\Domain\Stores\Models;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Customers\Models\Customer;
use App\Domain\DataTransfer\Models\DataExport;
use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\Documents\Models\Document;
use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Orders\Models\Order;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Shipping\Models\ShippingZone;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Support\Carbon;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $name
 * @property string $slug
 * @property string $status
 * @property string $country
 * @property string $currency
 * @property list<string> $business_categories
 * @property string|null $name_bn
 * @property string $timezone
 * @property Carbon|null $published_at
 * @property-read StoreDomain|null $primaryDomain
 * @property-read StoreSetting|null $settings
 * @property-read StoreTheme|null $activeTheme
 */
class Store extends Model
{
    use BelongsToTenant, HasUlids;

    public const STATUS_DRAFT = 'draft';

    public const STATUS_ACTIVE = 'active';

    public const STATUS_SUSPENDED = 'suspended';

    public const STATUSES = [self::STATUS_DRAFT, self::STATUS_ACTIVE, self::STATUS_SUSPENDED];

    protected $fillable = ['name', 'name_bn', 'slug', 'status', 'country', 'currency', 'business_categories', 'timezone'];

    protected function casts(): array
    {
        return ['business_categories' => 'array', 'published_at' => 'datetime'];
    }

    protected $attributes = ['status' => self::STATUS_DRAFT, 'business_categories' => '[]', 'timezone' => 'Asia/Dhaka'];

    public function domains(): HasMany
    {
        return $this->hasMany(StoreDomain::class);
    }

    public function primaryDomain(): HasOne
    {
        return $this->hasOne(StoreDomain::class)->where('is_primary', true);
    }

    public function settings(): HasOne
    {
        return $this->hasOne(StoreSetting::class);
    }

    public function themes(): HasMany
    {
        return $this->hasMany(StoreTheme::class);
    }

    public function activeTheme(): HasOne
    {
        return $this->hasOne(StoreTheme::class)->where('is_active', true);
    }

    public function pages(): HasMany
    {
        return $this->hasMany(StorePage::class);
    }

    public function navigation(): HasMany
    {
        return $this->hasMany(StoreNavigation::class);
    }

    // Phase 4: relations named after the route parameters so Route::scopeBindings() resolves nested ids
    // through the store ({product} → products(), {variant} → variants(), {import} → imports() …).

    public function products(): HasMany
    {
        return $this->hasMany(Product::class);
    }

    public function variants(): HasMany
    {
        return $this->hasMany(ProductVariant::class);
    }

    public function categories(): HasMany
    {
        return $this->hasMany(Category::class);
    }

    public function customers(): HasMany
    {
        return $this->hasMany(Customer::class);
    }

    public function imports(): HasMany
    {
        return $this->hasMany(DataImport::class);
    }

    public function exports(): HasMany
    {
        return $this->hasMany(DataExport::class);
    }

    // Phase 5: {zone}, {location}, {coupon}, {order} through the store (scopeBindings → foreign ids 404).

    public function zones(): HasMany
    {
        return $this->hasMany(ShippingZone::class);
    }

    public function locations(): HasMany
    {
        return $this->hasMany(PickupLocation::class);
    }

    public function coupons(): HasMany
    {
        return $this->hasMany(Coupon::class);
    }

    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    // Phase 5b: {return}, {document} through the store (scopeBindings → foreign ids 404).

    public function returns(): HasMany
    {
        return $this->hasMany(ReturnRequest::class);
    }

    public function documents(): HasMany
    {
        return $this->hasMany(Document::class);
    }
}
