<?php

declare(strict_types=1);

namespace App\Domain\Automations\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One executed action of a run (PHASE-8-6 §6, P86-5). UNIQUE(run_id, step_index): a message step row is inserted as
 * `sending` BEFORE the provider call, then `done` / `failed` by conditional UPDATE; `sending` > 15 min → `unknown`,
 * never retried. `step_index` is the 1-based position among the recipe's actions (waits have no row). The unsubscribe
 * code is stored as sha256 only.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $run_id
 * @property int $step_index
 * @property string $action send_message|add_tag|notify_team
 * @property string $status sending|done|skipped|failed|unknown
 * @property string|null $reason
 * @property string|null $channel
 * @property string|null $address
 * @property int $parts
 * @property string|null $unsubscribe_code_hash
 * @property string|null $provider_message_id
 * @property array<string, mixed>|null $detail
 * @property Carbon $executed_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class AutomationRunStep extends Model
{
    use BelongsToTenant, HasUlids;

    public const SEND_MESSAGE = 'send_message';

    public const ADD_TAG = 'add_tag';

    public const NOTIFY_TEAM = 'notify_team';

    public const ACTIONS = [self::SEND_MESSAGE, self::ADD_TAG, self::NOTIFY_TEAM];

    public const SENDING = 'sending';

    public const DONE = 'done';

    public const SKIPPED = 'skipped';

    public const FAILED = 'failed';

    public const UNKNOWN = 'unknown';

    public const STATUSES = [self::SENDING, self::DONE, self::SKIPPED, self::FAILED, self::UNKNOWN];

    /** Statuses of a message step that count toward allowances and the frequency cap. */
    public const COUNTED = [self::DONE, self::SENDING, self::UNKNOWN];

    public const REASONS = [
        'not_eligible', 'no_address', 'opted_out', 'frequency_cap', 'allowance', 'coupon_inactive',
        'no_customer', 'already_tagged', 'tags_full', 'no_recipients',
        'provider_error', 'invalid_address',
    ];

    protected $table = 'automation_run_steps';

    protected $fillable = [];

    protected $attributes = ['parts' => 0];

    protected function casts(): array
    {
        return ['detail' => 'array', 'parts' => 'integer', 'step_index' => 'integer', 'executed_at' => 'datetime'];
    }
}
