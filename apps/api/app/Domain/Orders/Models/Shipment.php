<?php

declare(strict_types=1);

namespace App\Domain\Orders\Models;

use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\Models\ShipmentBatch;
use App\Domain\Couriers\Models\ShipmentEvent;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * Shipment: manual (5a, `shipped` → delivered/returned/cancelled) or booked with a courier (5b-3, PHASE-5B §3 000800,
 * normalised statuses P5B-36). One active shipment per order: U(order_id) WHERE status NOT IN (cancelled,
 * booking_failed). Courier-written fields (consignment_id, cod_collected_amount, ...) are never mass-assignable (S39).
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
 * @property string|null $courier_account_id
 * @property string|null $consignment_id
 * @property string|null $provider_status
 * @property int $attempts
 * @property int|null $weight_grams
 * @property int|null $delivery_fee_amount
 * @property int|null $cod_charge_amount
 * @property int|null $cod_collected_amount
 * @property bool $cod_overridden
 * @property Carbon|null $last_event_at
 * @property Carbon|null $last_synced_at
 * @property Carbon|null $booked_at
 * @property Carbon|null $picked_up_at
 * @property Carbon|null $cancelled_at
 * @property Carbon|null $settled_at
 * @property string|null $last_location
 * @property string|null $failure_reason
 * @property string|null $problem
 * @property string|null $idempotency_key
 * @property array<array-key, mixed>|null $raw
 * @property string|null $batch_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Order $order
 * @property-read CourierAccount|null $courierAccount
 */
class Shipment extends Model
{
    use BelongsToTenant, HasUlids;

    public const MANUAL = 'manual';

    // 5a manual statuses
    public const SHIPPED = 'shipped';

    // 5b-3 normalised courier statuses (P5B-36)
    public const BOOKING = 'booking';

    public const BOOKED = 'booked';

    public const PICKED_UP = 'picked_up';

    public const IN_TRANSIT = 'in_transit';

    public const OUT_FOR_DELIVERY = 'out_for_delivery';

    public const ON_HOLD = 'on_hold';

    public const DELIVERY_FAILED = 'delivery_failed';

    public const DELIVERED = 'delivered';

    public const PARTIALLY_DELIVERED = 'partially_delivered';

    public const RETURNING = 'returning';

    public const RETURNED = 'returned';

    public const CANCELLED = 'cancelled';

    public const BOOKING_FAILED = 'booking_failed';

    /** Every value of the status CHECK (types ShipmentStatus). */
    public const STATUSES = [
        self::BOOKING, self::BOOKED, self::PICKED_UP, self::IN_TRANSIT, self::OUT_FOR_DELIVERY, self::ON_HOLD,
        self::DELIVERY_FAILED, self::DELIVERED, self::PARTIALLY_DELIVERED, self::RETURNING, self::RETURNED,
        self::CANCELLED, self::BOOKING_FAILED, self::SHIPPED,
    ];

    /** Statuses a courier status map may produce (everything except our own booking/booking_failed and 5a shipped). */
    public const COURIER_STATUSES = [
        self::BOOKED, self::PICKED_UP, self::IN_TRANSIT, self::OUT_FOR_DELIVERY, self::ON_HOLD, self::DELIVERY_FAILED,
        self::DELIVERED, self::PARTIALLY_DELIVERED, self::RETURNING, self::RETURNED, self::CANCELLED,
    ];

    /** No further courier updates are expected. */
    public const FINAL_STATUSES = [self::DELIVERED, self::PARTIALLY_DELIVERED, self::RETURNED, self::CANCELLED, self::BOOKING_FAILED];

    /** Not final (sync / disconnect guard `courier_busy`). */
    public const ACTIVE_STATUSES = [
        self::BOOKING, self::BOOKED, self::PICKED_UP, self::IN_TRANSIT, self::OUT_FOR_DELIVERY, self::ON_HOLD,
        self::DELIVERY_FAILED, self::RETURNING, self::SHIPPED,
    ];

    /** The parcel has left the merchant (first of these → order `shipped`, P5B-36). */
    public const PICKED_UP_STATUSES = [self::PICKED_UP, self::IN_TRANSIT, self::OUT_FOR_DELIVERY];

    public const PROBLEM_DELIVERY_FAILED = 'delivery_failed';

    public const PROBLEM_ON_HOLD = 'on_hold';

    public const PROBLEM_RETURNING = 'returning';

    public const PROBLEM_UNKNOWN = 'unknown';

    public const PROBLEMS = [self::PROBLEM_DELIVERY_FAILED, self::PROBLEM_ON_HOLD, self::PROBLEM_RETURNING, self::PROBLEM_UNKNOWN];

    protected $fillable = [];

    protected $hidden = ['raw', 'idempotency_key'];

    protected $attributes = ['provider' => self::MANUAL, 'cod_amount' => 0, 'attempts' => 0, 'cod_overridden' => false];

    protected function casts(): array
    {
        return [
            'cod_amount' => 'integer',
            'shipped_at' => 'datetime',
            'delivered_at' => 'datetime',
            'returned_at' => 'datetime',
            'attempts' => 'integer',
            'weight_grams' => 'integer',
            'delivery_fee_amount' => 'integer',
            'cod_charge_amount' => 'integer',
            'cod_collected_amount' => 'integer',
            'cod_overridden' => 'boolean',
            'last_event_at' => 'datetime',
            'last_synced_at' => 'datetime',
            'booked_at' => 'datetime',
            'picked_up_at' => 'datetime',
            'cancelled_at' => 'datetime',
            'settled_at' => 'datetime',
            'raw' => 'array',
        ];
    }

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class);
    }

    public function courierAccount(): BelongsTo
    {
        return $this->belongsTo(CourierAccount::class);
    }

    public function events(): HasMany
    {
        return $this->hasMany(ShipmentEvent::class)->orderBy('occurred_at')->orderBy('id');
    }

    public function batch(): BelongsTo
    {
        return $this->belongsTo(ShipmentBatch::class, 'batch_id');
    }

    public function isCourier(): bool
    {
        return $this->provider !== self::MANUAL;
    }

    public function isFinal(): bool
    {
        return in_array($this->status, self::FINAL_STATUSES, true);
    }

    /** The parcel was picked up at some point (Steadfast `cancelled` after pickup = returning, §6.1). */
    public function wasPickedUp(): bool
    {
        return $this->picked_up_at !== null || in_array($this->status, [
            self::PICKED_UP, self::IN_TRANSIT, self::OUT_FOR_DELIVERY, self::ON_HOLD, self::DELIVERY_FAILED,
            self::DELIVERED, self::PARTIALLY_DELIVERED, self::RETURNING, self::RETURNED, self::SHIPPED,
        ], true);
    }
}
