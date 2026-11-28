<?php

declare(strict_types=1);

namespace App\Domain\Support\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A support ticket (PHASE-8-9C §8, P89C-14 – P89C-19). Tenant-owned under forced RLS; `T-{number}` from a global
 * sequence. Staff (platform) actions resolve it on the admin connection, then act inside TenantContext::run.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string|null $store_id
 * @property int $number
 * @property string|null $requester_id
 * @property string $category
 * @property string $subject
 * @property string $priority
 * @property string $status
 * @property string|null $order_id
 * @property string|null $order_number
 * @property string|null $assignee_id
 * @property string $client_id
 * @property int $messages_count
 * @property Carbon $last_message_at
 * @property Carbon|null $last_merchant_reply_at
 * @property Carbon|null $first_staff_reply_at
 * @property Carbon|null $last_staff_reply_at
 * @property Carbon|null $waiting_since
 * @property Carbon|null $resolved_at
 * @property string|null $resolved_by_type
 * @property Carbon|null $closed_at
 * @property int $reopened_count
 * @property int|null $csat_rating
 * @property string|null $csat_comment
 * @property Carbon|null $csat_rated_at
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class SupportTicket extends Model
{
    use BelongsToTenant, HasUlids;

    public const OPEN = 'open';

    public const AWAITING_MERCHANT = 'awaiting_merchant';

    public const AWAITING_SUPPORT = 'awaiting_support';

    public const RESOLVED = 'resolved';

    public const CLOSED = 'closed';

    public const STATUSES = [self::OPEN, self::AWAITING_MERCHANT, self::AWAITING_SUPPORT, self::RESOLVED, self::CLOSED];

    /** Merchant tabs (P89C-16). */
    public const TABS = [
        'open' => [self::OPEN, self::AWAITING_SUPPORT],
        'waiting_on_you' => [self::AWAITING_MERCHANT],
        'solved' => [self::RESOLVED, self::CLOSED],
    ];

    public const CATEGORIES = [
        'orders_payments', 'shipping_couriers', 'products_inventory', 'storefront_domain', 'billing_plan', 'sms_marketing',
        'account_access', 'bug', 'other',
    ];

    public const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

    /** `low` is staff-only (P89C-14). */
    public const MERCHANT_PRIORITIES = ['normal', 'high', 'urgent'];

    public const OPEN_LIMIT = 20;

    public const AUTO_CLOSE_DAYS = 7;

    public const RATING_DAYS = 14;

    protected $table = 'support_tickets';

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'number' => 'integer',
            'messages_count' => 'integer',
            'last_message_at' => 'datetime',
            'last_merchant_reply_at' => 'datetime',
            'first_staff_reply_at' => 'datetime',
            'last_staff_reply_at' => 'datetime',
            'waiting_since' => 'datetime',
            'resolved_at' => 'datetime',
            'closed_at' => 'datetime',
            'reopened_count' => 'integer',
            'csat_rating' => 'integer',
            'csat_rated_at' => 'datetime',
            'revision' => 'integer',
        ];
    }

    public function reference(): string
    {
        return 'T-'.$this->number;
    }

    public function isClosed(): bool
    {
        return $this->status === self::CLOSED;
    }

    /** P89C-17: rating allowed while resolved/closed and resolved ≤ 14 days ago. */
    public function canRate(): bool
    {
        return in_array($this->status, [self::RESOLVED, self::CLOSED], true) && $this->resolved_at !== null
            && $this->resolved_at->gte(now()->subDays(self::RATING_DAYS));
    }
}
