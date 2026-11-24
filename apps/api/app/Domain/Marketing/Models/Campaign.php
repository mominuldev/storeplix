<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Models;

use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * A marketing campaign (PHASE-8-5 §3.1, P85-2 store-scoped). Nothing is mass-assignable: CampaignService maps fields.
 * State machine P85-17 (CampaignService / CampaignPipeline): draft → scheduled → sending → sent; draft|scheduled|
 * sending → cancelled; scheduled|sending → failed.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $name
 * @property string $channel sms|email
 * @property string $language bn|en
 * @property string $status
 * @property array<string, mixed> $audience
 * @property string $body
 * @property string|null $subject
 * @property string|null $coupon_id
 * @property string|null $product_id
 * @property Carbon|null $scheduled_at
 * @property Carbon|null $started_at
 * @property Carbon|null $completed_at
 * @property Carbon|null $cancelled_at
 * @property string|null $failure_reason
 * @property int $recipients_count
 * @property int $sent_count
 * @property int $failed_count
 * @property int $skipped_count
 * @property int $unsubscribed_count
 * @property int $parts_sent
 * @property string|null $created_by
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Coupon|null $coupon
 * @property-read Product|null $product
 * @property-read User|null $createdBy
 */
class Campaign extends Model
{
    use BelongsToTenant, HasUlids;

    public const SMS = 'sms';

    public const EMAIL = 'email';

    public const CHANNELS = [self::SMS, self::EMAIL];

    public const LANGUAGES = ['bn', 'en'];

    public const DRAFT = 'draft';

    public const SCHEDULED = 'scheduled';

    public const SENDING = 'sending';

    public const SENT = 'sent';

    public const CANCELLED = 'cancelled';

    public const FAILED = 'failed';

    public const STATUSES = [self::DRAFT, self::SCHEDULED, self::SENDING, self::SENT, self::CANCELLED, self::FAILED];

    /** P85-27: non-terminal states (count toward the 50-per-store bound). */
    public const OPEN = [self::DRAFT, self::SCHEDULED, self::SENDING];

    /** P85-17: editable states. */
    public const EDITABLE = [self::DRAFT, self::SCHEDULED];

    public const FAILURE_REASONS = ['limit', 'plan', 'store_unavailable', 'no_recipients'];

    protected $fillable = [];

    protected $attributes = [
        'status' => self::DRAFT, 'recipients_count' => 0, 'sent_count' => 0, 'failed_count' => 0, 'skipped_count' => 0,
        'unsubscribed_count' => 0, 'parts_sent' => 0, 'revision' => 1,
    ];

    protected function casts(): array
    {
        return [
            'audience' => 'array',
            'scheduled_at' => 'datetime',
            'started_at' => 'datetime',
            'completed_at' => 'datetime',
            'cancelled_at' => 'datetime',
            'recipients_count' => 'integer',
            'sent_count' => 'integer',
            'failed_count' => 'integer',
            'skipped_count' => 'integer',
            'unsubscribed_count' => 'integer',
            'parts_sent' => 'integer',
            'revision' => 'integer',
        ];
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function coupon(): BelongsTo
    {
        return $this->belongsTo(Coupon::class);
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class)->withTrashed();
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function recipients(): HasMany
    {
        return $this->hasMany(CampaignRecipient::class);
    }

    public function isSms(): bool
    {
        return $this->channel === self::SMS;
    }
}
