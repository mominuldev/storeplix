<?php

declare(strict_types=1);

namespace App\Domain\Billing\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * A Storeplix invoice to the merchant (PHASE-7 §3.2, P7-15). Nothing is mass-assignable: InvoiceService sets every
 * column; after issue only the status fields change (conditional updates).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $subscription_id
 * @property string $number
 * @property string $kind
 * @property string $status
 * @property string $plan_id
 * @property string $interval
 * @property string $currency
 * @property int $subtotal_amount
 * @property int $tax_amount
 * @property int $total_amount
 * @property int $tax_rate_bps
 * @property int $credit_amount
 * @property list<array<string, mixed>> $lines
 * @property array<string, string|null> $bill_to
 * @property Carbon|null $period_start
 * @property Carbon|null $period_end
 * @property Carbon $issued_at
 * @property Carbon $due_at
 * @property Carbon|null $paid_at
 * @property Carbon|null $voided_at
 * @property string|null $void_reason
 * @property bool $paid_late
 * @property string|null $paid_payment_id
 * @property list<string> $reminders
 * @property string|null $pdf_path
 * @property string|null $created_by
 * @property string|null $idempotency_key
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Plan $plan
 * @property-read Subscription $subscription
 */
class BillingInvoice extends Model
{
    use BelongsToTenant, HasUlids;

    public const NEW = 'new';

    public const UPGRADE = 'upgrade';

    public const RENEWAL = 'renewal';

    public const KINDS = [self::NEW, self::UPGRADE, self::RENEWAL];

    public const OPEN = 'open';

    public const PAID = 'paid';

    public const VOID = 'void';

    public const STATUSES = [self::OPEN, self::PAID, self::VOID];

    public const VOID_SUPERSEDED = 'superseded';

    public const VOID_EXPIRED = 'expired';

    public const VOID_UNPAID = 'unpaid';

    public const VOID_CANCELLED = 'cancelled';

    public const VOID_MANUAL = 'manual';

    public const VOID_REASONS = [self::VOID_SUPERSEDED, self::VOID_EXPIRED, self::VOID_UNPAID, self::VOID_CANCELLED, self::VOID_MANUAL];

    protected $fillable = [];

    protected $attributes = ['currency' => 'BDT', 'credit_amount' => 0, 'paid_late' => false, 'reminders' => '[]'];

    protected $hidden = ['idempotency_key', 'pdf_path'];

    protected function casts(): array
    {
        return [
            'subtotal_amount' => 'integer',
            'tax_amount' => 'integer',
            'total_amount' => 'integer',
            'tax_rate_bps' => 'integer',
            'credit_amount' => 'integer',
            'lines' => 'array',
            'bill_to' => 'array',
            'period_start' => 'datetime',
            'period_end' => 'datetime',
            'issued_at' => 'datetime',
            'due_at' => 'datetime',
            'paid_at' => 'datetime',
            'voided_at' => 'datetime',
            'paid_late' => 'boolean',
            'reminders' => 'array',
        ];
    }

    public function plan(): BelongsTo
    {
        return $this->belongsTo(Plan::class);
    }

    public function subscription(): BelongsTo
    {
        return $this->belongsTo(Subscription::class);
    }

    public function payments(): HasMany
    {
        return $this->hasMany(BillingPayment::class, 'invoice_id');
    }

    public function isOpen(): bool
    {
        return $this->status === self::OPEN;
    }

    public function isOverdue(): bool
    {
        return $this->status === self::OPEN && $this->due_at->isPast();
    }
}
