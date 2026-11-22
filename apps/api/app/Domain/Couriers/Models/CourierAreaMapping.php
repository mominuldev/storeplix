<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A remembered courier area for a district/thana (P5B-39). Composite primary key
 * (store_id, provider, district_code, thana_code); read and written through AreaMapper (upsert), never by id.
 *
 * @property string $tenant_id
 * @property string $store_id
 * @property string $provider
 * @property string $district_code
 * @property string $thana_code
 * @property string|null $provider_city_id
 * @property string|null $provider_zone_id
 * @property string|null $provider_area_id
 * @property string $label
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class CourierAreaMapping extends Model
{
    use BelongsToTenant;

    protected $primaryKey = null;

    public $incrementing = false;

    protected $fillable = [];

    protected $attributes = ['thana_code' => ''];

    /** @return array{city_id: ?string, zone_id: ?string, area_id: ?string} */
    public function toArea(): array
    {
        return ['city_id' => $this->provider_city_id, 'zone_id' => $this->provider_zone_id, 'area_id' => $this->provider_area_id];
    }
}
