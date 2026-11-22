<?php

namespace App\Domain\Orders\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Shipment (manual in 5a).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $order_id
 * @property string $provider
 * @property string|null $carrier_name
 * @property string|null $tracking_code
 * @property string|null $tracking_url
 * @property string $status
 * @property int $cod_amount
 * @property Carbon|null $shipped_at
 * @property Carbon|null $delivered_at
 * @property Carbon|null $returned_at
 * @property string|null $created_by
 */
class Shipment extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected $attributes = ['provider' => 'manual', 'cod_amount' => 0];

    protected function casts(): array
    {
        return ['cod_amount' => 'integer', 'shipped_at' => 'datetime', 'delivered_at' => 'datetime', 'returned_at' => 'datetime'];
    }
}
