<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A payment to a supplier (P88B-8): a record only (no payout). Optionally linked to one of the supplier's POs. Hard
 * delete with an audit snapshot. Never an expense (P88B-10). `paid_on` is a store-local `Y-m-d` string.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $supplier_id
 * @property string|null $purchase_order_id
 * @property int $amount
 * @property string $currency
 * @property string $method
 * @property string $paid_on
 * @property string|null $reference
 * @property string|null $note
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class SupplierPayment extends Model
{
    use BelongsToTenant, HasUlids;

    public const METHODS = ['cash', 'bkash', 'nagad', 'bank', 'card', 'other'];

    public const MAX_AMOUNT = 10_000_000_000;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['amount' => 'integer'];
    }

    public function paidOn(): string
    {
        return substr((string) $this->paid_on, 0, 10);
    }

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class);
    }

    public function purchaseOrder(): BelongsTo
    {
        return $this->belongsTo(PurchaseOrder::class);
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
