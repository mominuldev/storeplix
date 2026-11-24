<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Models\Location;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * One purchase order (PHASE-8-8B §3, §5). Store-scoped [S]. Written only by the purchasing services under a row lock;
 * money is recomputed server-side (S173). `expected_on` / `due_on` are store-local `Y-m-d` strings (no date cast).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $location_id PHASE-8-8C P88C-8 "Receive at"
 * @property string $supplier_id
 * @property int $sequence
 * @property string $number
 * @property string $status
 * @property string|null $expected_on
 * @property Carbon|null $ordered_at
 * @property Carbon|null $sent_at
 * @property string|null $sent_via
 * @property Carbon|null $closed_at
 * @property Carbon|null $cancelled_at
 * @property string|null $notes
 * @property int $subtotal_amount
 * @property int $shipping_amount
 * @property int $discount_amount
 * @property int $total_amount
 * @property int $received_value_amount
 * @property int $paid_amount
 * @property string $currency
 * @property string|null $due_on
 * @property int $revision
 * @property string|null $created_by
 * @property string|null $updated_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Supplier $supplier
 */
class PurchaseOrder extends Model
{
    use BelongsToTenant, HasUlids;

    public const DRAFT = 'draft';

    public const ORDERED = 'ordered';

    public const PARTIALLY_RECEIVED = 'partially_received';

    public const RECEIVED = 'received';

    public const CLOSED = 'closed';

    public const CANCELLED = 'cancelled';

    public const STATUSES = [self::DRAFT, self::ORDERED, self::PARTIALLY_RECEIVED, self::RECEIVED, self::CLOSED, self::CANCELLED];

    /** Still expected: counts as incoming stock and "on the way". */
    public const OPEN = [self::ORDERED, self::PARTIALLY_RECEIVED];

    /** P88B-2: lines, transport, discount and expected date are editable here. */
    public const EDITABLE = [self::DRAFT, self::ORDERED];

    public const SENT_VIA = ['whatsapp', 'pdf', 'manual'];

    public const MAX_LINES = 200;

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'sequence' => 'integer',
            'ordered_at' => 'datetime',
            'sent_at' => 'datetime',
            'closed_at' => 'datetime',
            'cancelled_at' => 'datetime',
            'subtotal_amount' => 'integer',
            'shipping_amount' => 'integer',
            'discount_amount' => 'integer',
            'total_amount' => 'integer',
            'received_value_amount' => 'integer',
            'paid_amount' => 'integer',
            'revision' => 'integer',
        ];
    }

    public static function numberFor(int $sequence): string
    {
        return 'PO-'.str_pad((string) $sequence, 4, '0', STR_PAD_LEFT);
    }

    public function expectedOn(): ?string
    {
        return $this->expected_on === null ? null : substr((string) $this->expected_on, 0, 10);
    }

    public function dueOn(): ?string
    {
        return $this->due_on === null ? null : substr((string) $this->due_on, 0, 10);
    }

    public function isOpen(): bool
    {
        return in_array($this->status, self::OPEN, true);
    }

    /** P88B-8: from payments linked to the PO vs its total. */
    public function paymentStatus(): string
    {
        return match (true) {
            $this->paid_amount <= 0 => 'unpaid',
            $this->paid_amount < $this->total_amount => 'partially_paid',
            $this->paid_amount === $this->total_amount => 'paid',
            default => 'overpaid',
        };
    }

    /** received value − linked payments (negative = advance / credit). */
    public function balance(): int
    {
        return $this->received_value_amount - $this->paid_amount;
    }

    /** P88B-9: due_on before today and still a balance. */
    public function isOverdue(string $today): bool
    {
        return $this->status !== self::CANCELLED && $this->dueOn() !== null && $this->dueOn() < $today && $this->balance() > 0;
    }

    /** Expected date passed, not fully received, status ordered / partially received. */
    public function isLate(string $today): bool
    {
        return $this->isOpen() && $this->expectedOn() !== null && $this->expectedOn() < $today;
    }

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class);
    }

    public function items(): HasMany
    {
        return $this->hasMany(PurchaseOrderItem::class)->orderBy('position')->orderBy('id');
    }

    public function receipts(): HasMany
    {
        return $this->hasMany(PurchaseReceipt::class);
    }

    public function payments(): HasMany
    {
        return $this->hasMany(SupplierPayment::class);
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /** PHASE-8-8C P88C-8: where receipts stock. */
    public function location(): BelongsTo
    {
        return $this->belongsTo(Location::class, 'location_id');
    }
}
