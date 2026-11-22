<?php

namespace App\Domain\Orders\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;
use LogicException;

/**
 * Append-only order timeline row (like InventoryMovement): updating or deleting throws.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $order_id
 * @property string $type
 * @property string|null $from_status
 * @property string|null $to_status
 * @property string $actor_type
 * @property string|null $actor_user_id
 * @property string|null $body
 * @property array<string, mixed> $meta
 * @property Carbon $created_at
 * @property-read User|null $actor
 */
class OrderEvent extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    public const TYPES = ['placed', 'status_changed', 'note', 'edited', 'payment', 'refund', 'shipment', 'notification', 'coupon_released', 'payment_link', 'items_edited', 'return', 'document'];

    protected $fillable = [];

    protected $attributes = ['meta' => '{}'];

    protected function casts(): array
    {
        return ['meta' => 'array', 'created_at' => 'datetime'];
    }

    protected static function booted(): void
    {
        static::updating(fn () => throw new LogicException('Order events are append-only.'));
        static::deleting(fn () => throw new LogicException('Order events are append-only.'));
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_user_id');
    }
}
