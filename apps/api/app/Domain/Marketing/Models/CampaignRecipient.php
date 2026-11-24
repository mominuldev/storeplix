<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Models;

use App\Domain\Customers\Models\Customer;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One customer × one campaign (PHASE-8-5 §7.1). Status P85-11: queued → sending → sent | failed (conditional UPDATEs
 * only), queued → skipped (§4.3), sending > 15 min → unknown (never retried). The unsubscribe code is stored as
 * sha256 only (P85-6); the rendered text is never stored (§5.2).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $campaign_id
 * @property string|null $customer_id
 * @property string $channel
 * @property string $address
 * @property string $status
 * @property string|null $skip_reason
 * @property string|null $error_code
 * @property int $parts
 * @property string $unsubscribe_code_hash
 * @property string|null $provider_message_id
 * @property Carbon|null $sent_at
 * @property Carbon|null $unsubscribed_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Customer|null $customer
 * @property-read Campaign|null $campaign
 */
class CampaignRecipient extends Model
{
    use BelongsToTenant, HasUlids;

    public const QUEUED = 'queued';

    public const SENDING = 'sending';

    public const SENT = 'sent';

    public const FAILED = 'failed';

    public const SKIPPED = 'skipped';

    public const UNKNOWN = 'unknown';

    public const STATUSES = [self::QUEUED, self::SENDING, self::SENT, self::FAILED, self::SKIPPED, self::UNKNOWN];

    /** §2.2: statuses that consume allowance. */
    public const COUNTED = [self::SENT, self::SENDING, self::UNKNOWN];

    public const SKIP_REASONS = ['opted_out', 'customer_deleted', 'address_changed', 'not_eligible', 'cancelled', 'plan', 'store_unavailable'];

    public const ERROR_CODES = ['provider_error', 'invalid_address'];

    protected $fillable = [];

    protected $attributes = ['status' => self::QUEUED, 'parts' => 0];

    protected function casts(): array
    {
        return ['parts' => 'integer', 'sent_at' => 'datetime', 'unsubscribed_at' => 'datetime'];
    }

    public function campaign(): BelongsTo
    {
        return $this->belongsTo(Campaign::class);
    }

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }
}
