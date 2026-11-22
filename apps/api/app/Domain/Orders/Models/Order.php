<?php

namespace App\Domain\Orders\Models;

use App\Domain\Customers\Models\Customer;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Support\Carbon;

/**
 * Order (ADR 0011). Nothing is mass-assignable: OrderPlacementService and OrderService set every column explicitly.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $number
 * @property int $sequence
 * @property string $status
 * @property string $payment_status
 * @property string $payment_method
 * @property string $created_via
 * @property string $channel
 * @property string|null $customer_id
 * @property string $customer_name
 * @property string $customer_phone
 * @property string|null $customer_email
 * @property array<string, mixed> $shipping_address
 * @property string $district_code
 * @property string $currency
 * @property int $subtotal_amount
 * @property int $discount_amount
 * @property int $shipping_amount
 * @property int $shipping_discount_amount
 * @property int $tax_amount
 * @property int $total_amount
 * @property int $paid_amount
 * @property int $refunded_amount
 * @property string|null $coupon_id
 * @property string|null $coupon_code
 * @property string|null $shipping_zone_id
 * @property string $shipping_zone_name
 * @property int|null $delivery_min_days
 * @property int|null $delivery_max_days
 * @property bool $shipping_overridden
 * @property string|null $customer_note
 * @property list<string> $tags
 * @property int $revision
 * @property string|null $idempotency_key
 * @property string|null $confirmation_token_hash
 * @property Carbon|null $confirmation_expires_at
 * @property string|null $cancel_reason
 * @property Carbon $placed_at
 * @property Carbon|null $confirmed_at
 * @property Carbon|null $shipped_at
 * @property Carbon|null $delivered_at
 * @property Carbon|null $returned_at
 * @property Carbon|null $cancelled_at
 * @property string|null $created_by
 * @property string|null $ip
 * @property string|null $user_agent
 * @property Carbon|null $payment_expires_at
 * @property string $return_status
 * @property string|null $source_order_id
 * @property Carbon|null $invoice_printed_at
 * @property Carbon|null $label_printed_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Order extends Model
{
    use BelongsToTenant, HasUlids;

    public const PENDING_PAYMENT = 'pending_payment';

    public const PENDING = 'pending';

    public const CONFIRMED = 'confirmed';

    public const READY_TO_SHIP = 'ready_to_ship';

    public const SHIPPED = 'shipped';

    public const DELIVERED = 'delivered';

    public const RETURNED = 'returned';

    public const CANCELLED = 'cancelled';

    public const STATUSES = [self::PENDING_PAYMENT, self::PENDING, self::CONFIRMED, self::READY_TO_SHIP, self::SHIPPED, self::DELIVERED, self::RETURNED, self::CANCELLED];

    public const EDITABLE = [self::PENDING, self::CONFIRMED, self::READY_TO_SHIP];

    public const PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded'];

    public const CHANNELS = ['website', 'facebook', 'instagram', 'whatsapp', 'phone', 'walk_in', 'landing_page', 'other'];

    public const CANCEL_REASONS = ['customer_request', 'fake_order', 'unreachable', 'out_of_stock', 'duplicate', 'other'];

    public const MAX_ITEMS = 50;

    /** Post-delivery return state (P5B-68), derived by ReturnService. */
    public const RETURN_STATUSES = ['none', 'requested', 'partially_returned', 'returned'];

    protected $fillable = [];

    protected $hidden = ['confirmation_token_hash'];

    protected $attributes = [
        'return_status' => 'none',
        'payment_status' => 'unpaid', 'tags' => '[]', 'revision' => 1, 'shipping_overridden' => false,
        'subtotal_amount' => 0, 'discount_amount' => 0, 'shipping_amount' => 0, 'shipping_discount_amount' => 0,
        'tax_amount' => 0, 'total_amount' => 0, 'paid_amount' => 0, 'refunded_amount' => 0,
    ];

    protected function casts(): array
    {
        $casts = [
            'sequence' => 'integer',
            'shipping_address' => 'array',
            'tags' => 'array',
            'delivery_min_days' => 'integer',
            'delivery_max_days' => 'integer',
            'shipping_overridden' => 'boolean',
            'revision' => 'integer',
            'confirmation_expires_at' => 'datetime',
            'placed_at' => 'datetime',
            'confirmed_at' => 'datetime',
            'shipped_at' => 'datetime',
            'delivered_at' => 'datetime',
            'returned_at' => 'datetime',
            'cancelled_at' => 'datetime',
            'payment_expires_at' => 'datetime',
            'invoice_printed_at' => 'datetime',
            'label_printed_at' => 'datetime',
        ];
        foreach (['subtotal', 'discount', 'shipping', 'shipping_discount', 'tax', 'total', 'paid', 'refunded'] as $money) {
            $casts["{$money}_amount"] = 'integer';
        }

        return $casts;
    }

    public function dueAmount(): int
    {
        return max(0, $this->total_amount - $this->paid_amount);
    }

    public function items(): HasMany
    {
        return $this->hasMany(OrderItem::class)->orderBy('position')->orderBy('id');
    }

    public function events(): HasMany
    {
        return $this->hasMany(OrderEvent::class)->orderByDesc('created_at')->orderByDesc('id');
    }

    public function payments(): HasMany
    {
        return $this->hasMany(Payment::class)->orderBy('created_at')->orderBy('id');
    }

    public function shipments(): HasMany
    {
        return $this->hasMany(Shipment::class)->orderBy('created_at')->orderBy('id');
    }

    public function shipment(): HasOne
    {
        return $this->hasOne(Shipment::class)->where('status', '<>', 'cancelled');
    }

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class)->withTrashed();
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
