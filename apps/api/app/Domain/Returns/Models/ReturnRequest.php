<?php

namespace App\Domain\Returns\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * Post-delivery return or exchange (P5B-63..P5B-67). Only ReturnService writes it; nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $order_id
 * @property string $number
 * @property int $sequence
 * @property string $type
 * @property string $status
 * @property string $reason
 * @property string $source
 * @property string|null $customer_note
 * @property string|null $pickup_tracking_code
 * @property array<string, bool> $checks
 * @property int $requested_amount
 * @property int $refunded_amount
 * @property string|null $exchange_order_id
 * @property string|null $reject_reason
 * @property Carbon|null $approved_at
 * @property Carbon|null $received_at
 * @property Carbon|null $closed_at
 * @property string|null $created_by
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Order $order
 * @property-read Order|null $exchangeOrder
 */
class ReturnRequest extends Model
{
    use BelongsToTenant, HasUlids;

    public const REQUESTED = 'requested';

    public const APPROVED = 'approved';

    public const RECEIVED = 'received';

    public const REFUNDED = 'refunded';

    public const EXCHANGED = 'exchanged';

    public const REJECTED = 'rejected';

    public const CLOSED = 'closed';

    public const STATUSES = [self::REQUESTED, self::APPROVED, self::RECEIVED, self::REFUNDED, self::EXCHANGED, self::REJECTED, self::CLOSED];

    /** Not final yet ("open" tab / KPI). */
    public const OPEN = [self::REQUESTED, self::APPROVED, self::RECEIVED];

    public const TYPES = ['return', 'exchange'];

    public const REASONS = ['wrong_size', 'damaged', 'wrong_item', 'changed_mind', 'refused_at_door', 'other'];

    protected $table = 'return_requests';

    protected $fillable = [];

    protected $attributes = ['checks' => '{}', 'requested_amount' => 0, 'refunded_amount' => 0, 'revision' => 1, 'source' => 'merchant'];

    protected function casts(): array
    {
        return [
            'sequence' => 'integer',
            'checks' => 'array',
            'requested_amount' => 'integer',
            'refunded_amount' => 'integer',
            'revision' => 'integer',
            'approved_at' => 'datetime',
            'received_at' => 'datetime',
            'closed_at' => 'datetime',
        ];
    }

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class);
    }

    public function exchangeOrder(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'exchange_order_id');
    }

    public function items(): HasMany
    {
        return $this->hasMany(ReturnItem::class, 'return_request_id')->orderBy('id');
    }

    public function events(): HasMany
    {
        return $this->hasMany(ReturnEvent::class, 'return_request_id')->orderByDesc('created_at')->orderByDesc('id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
