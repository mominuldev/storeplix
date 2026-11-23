<?php

declare(strict_types=1);

namespace App\Domain\Billing\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A payment attempt of a billing invoice through the platform gateway accounts (P7-9–P7-14). Status changes are
 * conditional updates in BillingPaymentService only. `raw` (scrubbed provider answers) never leaves the API.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $invoice_id
 * @property string $provider
 * @property string $status
 * @property int $amount
 * @property string $currency
 * @property string|null $provider_payment_id
 * @property string|null $provider_trx_id
 * @property string|null $failure_code
 * @property bool $is_duplicate
 * @property array<string, mixed>|null $raw
 * @property Carbon $expires_at
 * @property Carbon|null $verified_at
 * @property Carbon|null $last_queried_at
 * @property string|null $initiated_by
 * @property string|null $idempotency_key
 * @property string|null $reference
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read BillingInvoice $invoice
 */
class BillingPayment extends Model
{
    use BelongsToTenant, HasUlids;

    public const BKASH = 'bkash';

    public const SSLCOMMERZ = 'sslcommerz';

    public const MANUAL = 'manual';

    public const GATEWAYS = [self::BKASH, self::SSLCOMMERZ];

    public const PENDING = 'pending';

    public const SUCCEEDED = 'succeeded';

    public const FAILED = 'failed';

    public const CANCELLED = 'cancelled';

    protected $fillable = [];

    protected $attributes = ['currency' => 'BDT', 'is_duplicate' => false];

    protected $hidden = ['raw', 'idempotency_key', 'provider_payment_id'];

    protected function casts(): array
    {
        return [
            'amount' => 'integer',
            'is_duplicate' => 'boolean',
            'raw' => 'array',
            'expires_at' => 'datetime',
            'verified_at' => 'datetime',
            'last_queried_at' => 'datetime',
        ];
    }

    public function invoice(): BelongsTo
    {
        return $this->belongsTo(BillingInvoice::class, 'invoice_id');
    }
}
