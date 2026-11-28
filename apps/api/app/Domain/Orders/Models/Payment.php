<?php

namespace App\Domain\Orders\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Payment row (P5-18): the COD charge of an order, or a manual refund record. 5b-2 (PHASE-5B §3 000300): online
 * charges through a merchant gateway account (`purpose` order|advance|link|exchange|test; test charges have no
 * order), gateway refunds (`refunded_amount` on the charge), hold `expires_at`, `failure_code`, `attempt`.
 * `raw` keeps scrubbed provider responses (PayloadScrubber) and is hidden.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string|null $order_id
 * @property string $provider
 * @property string $type
 * @property string $status
 * @property int $amount
 * @property string $currency
 * @property string|null $method
 * @property string|null $reference
 * @property string|null $note
 * @property string|null $parent_payment_id
 * @property string|null $idempotency_key
 * @property string|null $actor_user_id
 * @property string|null $return_request_id
 * @property string|null $provider_payment_id
 * @property array<string, mixed>|null $raw
 * @property Carbon|null $verified_at
 * @property string $purpose
 * @property string|null $gateway_account_id
 * @property string|null $payment_link_id
 * @property string|null $provider_trx_id
 * @property int $refunded_amount
 * @property Carbon|null $expires_at
 * @property string|null $failure_code
 * @property int $attempt
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read User|null $actor
 * @property-read Order|null $order
 * @property-read PaymentGatewayAccount|null $gatewayAccount
 * @property-read PaymentLink|null $paymentLink
 */
class Payment extends Model
{
    use BelongsToTenant, HasUlids;

    public const REFUND_METHODS = ['cash', 'bkash_personal', 'nagad_personal', 'bank', 'other', 'card']; // PHASE-8-8D: + card (P88D-9)

    /** 5b P5B-24: refunds through the gateway of the charge. */
    public const METHOD_GATEWAY = 'gateway';

    public const TYPE_CHARGE = 'charge';

    public const TYPE_REFUND = 'refund';

    public const STATUS_PENDING = 'pending';

    public const STATUS_SUCCEEDED = 'succeeded';

    public const STATUS_FAILED = 'failed';

    public const STATUS_CANCELLED = 'cancelled';

    public const PROVIDER_COD = 'cod';

    public const PROVIDER_MANUAL = 'manual';

    /** Online providers (PaymentGatewayAccount::PROVIDERS). */
    public const ONLINE_PROVIDERS = ['bkash', 'sslcommerz', 'nagad']; // PHASE-8-9D: + nagad

    public const PURPOSE_ORDER = 'order';

    public const PURPOSE_ADVANCE = 'advance';

    public const PURPOSE_LINK = 'link';

    public const PURPOSE_EXCHANGE = 'exchange';

    public const PURPOSE_TEST = 'test';

    public const PURPOSES = [self::PURPOSE_ORDER, self::PURPOSE_ADVANCE, self::PURPOSE_LINK, self::PURPOSE_EXCHANGE, self::PURPOSE_TEST];

    protected $fillable = [];

    protected $hidden = ['raw'];

    protected $attributes = ['purpose' => self::PURPOSE_ORDER, 'refunded_amount' => 0, 'attempt' => 1];

    protected function casts(): array
    {
        return [
            'amount' => 'integer',
            'raw' => 'array',
            'verified_at' => 'datetime',
            'refunded_amount' => 'integer',
            'expires_at' => 'datetime',
            'attempt' => 'integer',
        ];
    }

    public function isOnline(): bool
    {
        return in_array($this->provider, self::ONLINE_PROVIDERS, true);
    }

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class);
    }

    public function gatewayAccount(): BelongsTo
    {
        return $this->belongsTo(PaymentGatewayAccount::class, 'gateway_account_id');
    }

    public function paymentLink(): BelongsTo
    {
        return $this->belongsTo(PaymentLink::class, 'payment_link_id');
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_user_id');
    }
}
