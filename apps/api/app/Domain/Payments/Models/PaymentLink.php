<?php

declare(strict_types=1);

namespace App\Domain\Payments\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * Merchant payment link (P5B-22). The token is stored as sha256 (`token_hash`, lookup) and encrypted
 * (`token_encrypted`, Copy link / Resend); never in plain text. Written only by PaymentLinkService.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $order_id
 * @property string $token_hash
 * @property string $token_encrypted
 * @property string $amount_kind
 * @property int|null $percent_bps
 * @property int $amount
 * @property string $provider
 * @property string $status
 * @property Carbon $expires_at
 * @property bool $cancel_if_unpaid
 * @property list<string> $sent_via
 * @property Carbon|null $paid_at
 * @property Carbon|null $cancelled_at
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class PaymentLink extends Model
{
    use BelongsToTenant, HasUlids;

    public const ACTIVE = 'active';

    public const PAID = 'paid';

    public const EXPIRED = 'expired';

    public const CANCELLED = 'cancelled';

    public const STATUSES = [self::ACTIVE, self::PAID, self::EXPIRED, self::CANCELLED];

    public const AMOUNT_KINDS = ['delivery_charge', 'percent', 'full', 'custom'];

    public const EXPIRY_MINUTES = [120, 360, 1440, 2880];

    protected $fillable = [];

    protected $hidden = ['token_hash', 'token_encrypted'];

    protected $attributes = ['status' => self::ACTIVE, 'sent_via' => '[]'];

    protected function casts(): array
    {
        return [
            'amount' => 'integer',
            'percent_bps' => 'integer',
            'expires_at' => 'datetime',
            'cancel_if_unpaid' => 'boolean',
            'sent_via' => 'array',
            'paid_at' => 'datetime',
            'cancelled_at' => 'datetime',
        ];
    }

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class);
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function payments(): HasMany
    {
        return $this->hasMany(Payment::class, 'payment_link_id');
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }
}
