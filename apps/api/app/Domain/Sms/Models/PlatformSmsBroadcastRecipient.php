<?php

declare(strict_types=1);

namespace App\Domain\Sms\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9B §3.1: one tenant (owner) of a broadcast. `tenant_id` is the subject, not an RLS owner (platform-only table).
 *
 * @property string $id
 * @property string $broadcast_id
 * @property string $tenant_id
 * @property string|null $user_id
 * @property string|null $to
 * @property string $language
 * @property string $status pending|sent|failed|skipped
 * @property string|null $skip_reason
 * @property int|null $parts
 * @property string|null $opt_out_code_hash
 * @property string|null $sms_message_id
 * @property Carbon|null $sent_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class PlatformSmsBroadcastRecipient extends Model
{
    use HasUlids;

    public const PENDING = 'pending';

    public const SENT = 'sent';

    public const FAILED = 'failed';

    public const SKIPPED = 'skipped';

    public const STATUSES = [self::PENDING, self::SENT, self::FAILED, self::SKIPPED];

    public const SKIP_REASONS = ['opted_out', 'no_verified_phone', 'weekly_cap', 'suspended', 'duplicate'];

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['parts' => 'integer', 'sent_at' => 'datetime'];
    }
}
