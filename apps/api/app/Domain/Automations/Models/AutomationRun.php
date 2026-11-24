<?php

declare(strict_types=1);

namespace App\Domain\Automations\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * One evaluation of one automation for one trigger occurrence (PHASE-8-6 §4.2). Inserted once per
 * UNIQUE(automation_id, dedupe_key) (P86-4); every status change is a conditional UPDATE. `contact_address` is the
 * normalized phone/email used for exit matching and messages — masked in every response. `context` is the snapshot
 * taken at trigger time (internal keys like `contact_name` are never returned as-is, see RunPresenter).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $automation_id
 * @property string $trigger
 * @property string $dedupe_key
 * @property string $subject_type order|cart|return|inventory
 * @property string $subject_id
 * @property string|null $customer_id
 * @property string|null $contact_address
 * @property string $status
 * @property string|null $outcome_reason
 * @property array<string, mixed>|null $outcome_detail
 * @property int $next_step
 * @property Carbon|null $resume_at
 * @property string|null $recovery_code_hash
 * @property Carbon|null $window_ends_at
 * @property array<string, mixed> $context
 * @property Carbon $started_at
 * @property Carbon|null $finished_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Automation|null $automation
 */
class AutomationRun extends Model
{
    use BelongsToTenant, HasUlids;

    public const RUNNING = 'running';

    public const WAITING = 'waiting';

    public const COMPLETED = 'completed';

    public const SKIPPED = 'skipped';

    public const STOPPED = 'stopped';

    public const FAILED = 'failed';

    public const STATUSES = [self::RUNNING, self::WAITING, self::COMPLETED, self::SKIPPED, self::STOPPED, self::FAILED];

    public const OPEN = [self::RUNNING, self::WAITING];

    public const OUTCOME_REASONS = [
        'conditions_not_met', 'subject_missing', 'no_eligible_address',
        'converted', 'window_ended', 'opted_out', 'automation_off', 'plan',
        'error',
    ];

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'outcome_detail' => 'array',
            'context' => 'array',
            'next_step' => 'integer',
            'resume_at' => 'datetime',
            'window_ends_at' => 'datetime',
            'started_at' => 'datetime',
            'finished_at' => 'datetime',
        ];
    }

    public function automation(): BelongsTo
    {
        return $this->belongsTo(Automation::class);
    }

    public function steps(): HasMany
    {
        return $this->hasMany(AutomationRunStep::class, 'run_id')->orderBy('step_index');
    }
}
