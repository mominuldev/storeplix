<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9D §5.5: first-party ids and consent saved at checkout for the order's server events (one per order).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $order_id
 * @property string $consent
 * @property string|null $fbp
 * @property string|null $fbc
 * @property string|null $ttp
 * @property string|null $ttclid
 * @property string|null $ga_client_id
 * @property string|null $ga_session_id
 * @property string|null $client_ip
 * @property string|null $user_agent
 * @property Carbon|null $created_at
 */
class OrderTrackingContext extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    protected $table = 'order_tracking_contexts';

    protected $fillable = [];

    protected $hidden = ['client_ip', 'user_agent'];
}
