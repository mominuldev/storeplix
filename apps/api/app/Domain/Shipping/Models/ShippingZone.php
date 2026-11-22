<?php

namespace App\Domain\Shipping\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Delivery zone (P5-7). Exactly one `fallback` zone per store ("Everywhere else"): no areas, always active.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $name
 * @property string $kind
 * @property int $charge_amount
 * @property int $min_days
 * @property int $max_days
 * @property bool $is_active
 * @property int $position
 * @property string|null $pickup_location_id
 */
class ShippingZone extends Model
{
    use BelongsToTenant, HasUlids;

    public const CUSTOM = 'custom';

    public const FALLBACK = 'fallback';

    public const MAX_ZONES = 30;

    public const MAX_AREAS = 500;

    protected $fillable = ['name', 'kind', 'charge_amount', 'min_days', 'max_days', 'is_active', 'position'];

    protected $attributes = ['is_active' => true, 'position' => 0];

    protected function casts(): array
    {
        return ['charge_amount' => 'integer', 'min_days' => 'integer', 'max_days' => 'integer', 'is_active' => 'boolean', 'position' => 'integer'];
    }

    public function areas(): HasMany
    {
        return $this->hasMany(ShippingZoneArea::class, 'zone_id');
    }

    public function isFallback(): bool
    {
        return $this->kind === self::FALLBACK;
    }
}
