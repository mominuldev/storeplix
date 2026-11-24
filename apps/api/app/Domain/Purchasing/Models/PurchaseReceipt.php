<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Models\Location;
use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * One delivery recorded against a PO (PHASE-8-8B §3, §5.3). Never deleted (a wrong receipt is corrected with an
 * inventory correction + a manual cost edit, RUNBOOK). `value_amount` = Σ received × landed unit cost.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $location_id PHASE-8-8C P88C-8 "Receive at"
 * @property string $purchase_order_id
 * @property Carbon $received_at
 * @property string|null $received_by
 * @property string|null $supplier_invoice_ref
 * @property string|null $invoice_media_id
 * @property string|null $note
 * @property int $value_amount
 * @property Carbon $created_at
 */
class PurchaseReceipt extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['received_at' => 'datetime', 'value_amount' => 'integer'];
    }

    public function items(): HasMany
    {
        return $this->hasMany(PurchaseReceiptItem::class)->orderBy('id');
    }

    public function receivedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'received_by');
    }

    public function invoice(): BelongsTo
    {
        return $this->belongsTo(Media::class, 'invoice_media_id');
    }

    public function purchaseOrder(): BelongsTo
    {
        return $this->belongsTo(PurchaseOrder::class);
    }

    /** PHASE-8-8C P88C-8: where receipts stock. */
    public function location(): BelongsTo
    {
        return $this->belongsTo(Location::class, 'location_id');
    }
}
