<?php

namespace App\Domain\Billing\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One current (trialing|active|past_due) row per tenant, mutated in place (P7-2). Status changes go through
 * SubscriptionStateMachine only.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $plan_id
 * @property string $status
 * @property string $billing_interval
 * @property Carbon|null $trial_ends_at
 * @property Carbon|null $current_period_start
 * @property Carbon|null $current_period_end
 * @property bool $cancel_at_period_end
 * @property string|null $scheduled_plan_id
 * @property string|null $scheduled_interval
 * @property Carbon|null $past_due_at
 * @property Carbon|null $grace_ends_at
 * @property Carbon|null $domain_grace_ends_at
 * @property Carbon|null $ended_at
 * @property Carbon|null $cancelled_at
 * @property Carbon|null $plan_changed_at
 * @property string|null $ended_reason
 * @property array<string, string> $notices
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Plan $plan
 * @property-read Plan|null $scheduledPlan
 */
class Subscription extends Model
{
    use BelongsToTenant, HasUlids;

    public const TRIALING = 'trialing';

    public const ACTIVE = 'active';

    public const PAST_DUE = 'past_due';

    public const CANCELLED = 'cancelled';

    public const EXPIRED = 'expired';

    public const STATUSES = [self::TRIALING, self::ACTIVE, self::PAST_DUE, self::CANCELLED, self::EXPIRED];

    public const CURRENT_STATUSES = [self::TRIALING, self::ACTIVE, self::PAST_DUE];

    public const TRIAL_DAYS = 14;

    public const ENDED_UNPAID = 'unpaid';

    public const ENDED_CANCELLED = 'cancelled';

    protected $fillable = ['plan_id', 'status', 'trial_ends_at', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'billing_interval'];

    protected $attributes = ['billing_interval' => 'month', 'notices' => '{}'];

    protected function casts(): array
    {
        return [
            'trial_ends_at' => 'datetime',
            'current_period_start' => 'datetime',
            'current_period_end' => 'datetime',
            'cancel_at_period_end' => 'boolean',
            'past_due_at' => 'datetime',
            'grace_ends_at' => 'datetime',
            'domain_grace_ends_at' => 'datetime',
            'ended_at' => 'datetime',
            'cancelled_at' => 'datetime',
            'plan_changed_at' => 'datetime',
            'notices' => 'array',
        ];
    }

    public function plan(): BelongsTo
    {
        return $this->belongsTo(Plan::class);
    }

    public function scheduledPlan(): BelongsTo
    {
        return $this->belongsTo(Plan::class, 'scheduled_plan_id');
    }

    public function isPaidPlan(): bool
    {
        return ! $this->plan->isFree();
    }

    public function hasNotice(string $key): bool
    {
        return isset(($this->notices ?? [])[$key]);
    }
}
