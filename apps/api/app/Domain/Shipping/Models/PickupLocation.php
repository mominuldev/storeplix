<?php

namespace App\Domain\Shipping\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Pickup address (onboarding 06; courier pickups in 5b). At most one default per store (partial unique index).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $name
 * @property string|null $contact_name
 * @property string|null $contact_phone
 * @property string $district_code
 * @property string $thana_code
 * @property string $address_line
 * @property bool $is_default
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class PickupLocation extends Model
{
    use BelongsToTenant, HasUlids;

    public const MAX_PER_STORE = 10;

    protected $fillable = ['name', 'contact_name', 'contact_phone', 'district_code', 'thana_code', 'address_line'];

    protected $attributes = ['is_default' => false];

    protected function casts(): array
    {
        return ['is_default' => 'boolean'];
    }
}
