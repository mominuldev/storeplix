<?php

namespace App\Domain\Shipping\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Model;

/**
 * One area of a zone: a whole district (thana_code '') or one thana. Composite primary key; written in bulk by
 * ShippingService only.
 *
 * @property string $tenant_id
 * @property string $store_id
 * @property string $zone_id
 * @property string $district_code
 * @property string $thana_code
 */
class ShippingZoneArea extends Model
{
    use BelongsToTenant;

    public $incrementing = false;

    public $timestamps = false;

    protected $primaryKey = 'zone_id';

    protected $keyType = 'string';

    protected $fillable = [];
}
