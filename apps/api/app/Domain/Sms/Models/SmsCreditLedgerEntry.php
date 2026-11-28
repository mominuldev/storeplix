<?php

declare(strict_types=1);

namespace App\Domain\Sms\Models;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One SMS credit movement (PHASE-8-9A §3.1). APPEND-ONLY (RLS SELECT + INSERT only, no UPDATE/DELETE grant): rows are
 * inserted by SmsCreditService / SmsCharger and never changed. Signed `credits`; `balance_after` = the account balance
 * right after this row.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $type purchase|consume|refund|admin_adjust
 * @property int $credits
 * @property int $balance_after
 * @property string|null $sms_message_id
 * @property string|null $billing_invoice_id
 * @property string|null $reason
 * @property string $actor_type system|user|platform
 * @property string|null $actor_user_id
 * @property string|null $idempotency_key
 * @property string|null $request_hash
 * @property Carbon $created_at
 * @property-read BillingInvoice|null $invoice
 */
class SmsCreditLedgerEntry extends Model
{
    use BelongsToTenant, HasUlids;

    public const PURCHASE = 'purchase';

    public const CONSUME = 'consume';

    public const REFUND = 'refund';

    public const ADMIN_ADJUST = 'admin_adjust';

    public const TYPES = [self::PURCHASE, self::CONSUME, self::REFUND, self::ADMIN_ADJUST];

    public const UPDATED_AT = null;

    protected $table = 'sms_credit_ledger';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['credits' => 'integer', 'balance_after' => 'integer', 'created_at' => 'datetime'];
    }

    public function invoice(): BelongsTo
    {
        return $this->belongsTo(BillingInvoice::class, 'billing_invoice_id');
    }
}
