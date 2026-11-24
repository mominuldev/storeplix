<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Models;

use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Decision log row (PHASE-8-8 §4). Append-only; `detail` never holds a raw phone (P88-16). Pruned after 13 months.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $type
 * @property string|null $order_id
 * @property string $phone
 * @property array<string, mixed> $detail
 * @property Carbon $created_at
 */
class FraudGuardEvent extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    public const TYPES = ['held', 'advance_asked', 'advance_paid', 'released', 'duplicate', 'blocked_checkout', 'limit_reached', 'auto_blocked', 'otp_failed'];

    protected $fillable = [];

    protected $attributes = ['detail' => '{}'];

    protected function casts(): array
    {
        return ['detail' => 'array', 'created_at' => 'datetime'];
    }

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class);
    }
}
