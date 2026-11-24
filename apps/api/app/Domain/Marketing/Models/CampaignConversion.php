<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * An order attributed to a campaign (P85-21): one row per order (unique order_id). Revenue is evaluated at read time
 * (order `total_amount`, cancelled excluded).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $campaign_id
 * @property string|null $recipient_id
 * @property string $order_id
 * @property Carbon $placed_at
 * @property Carbon|null $created_at
 */
class CampaignConversion extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['placed_at' => 'datetime'];
    }
}
