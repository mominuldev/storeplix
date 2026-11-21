<?php

namespace App\Domain\Stores\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

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
 * @property-read StoreDomain|null $primaryDomain
 * @property-read StoreSetting|null $settings
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
        return ['business_categories' => 'array'];
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
}
