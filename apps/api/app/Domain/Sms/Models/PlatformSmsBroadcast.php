<?php

declare(strict_types=1);

namespace App\Domain\Sms\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9B §3.1, §7: a promotional broadcast. Platform-only table (no app-role grant): always read and written through
 * PlatformDb (BroadcastService::query()).
 *
 * @property string $id
 * @property string $name
 * @property string $body_bn
 * @property string $body_en
 * @property array<string, mixed> $audience
 * @property string $status
 * @property Carbon|null $scheduled_at
 * @property Carbon|null $started_at
 * @property Carbon|null $finished_at
 * @property array<string, mixed>|null $estimate
 * @property int $recipients_count
 * @property int $sent_count
 * @property int $failed_count
 * @property int $skipped_count
 * @property string|null $provider_id
 * @property string|null $sender_id
 * @property string|null $failure_reason
 * @property string|null $created_by
 * @property string|null $confirmed_by
 * @property string|null $cancelled_by
 * @property Carbon|null $confirmed_at
 * @property Carbon|null $cancelled_at
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class PlatformSmsBroadcast extends Model
{
    use HasUlids;

    public const DRAFT = 'draft';

    public const SCHEDULED = 'scheduled';

    public const SENDING = 'sending';

    public const SENT = 'sent';

    public const CANCELLED = 'cancelled';

    public const FAILED = 'failed';

    public const STATUSES = [self::DRAFT, self::SCHEDULED, self::SENDING, self::SENT, self::CANCELLED, self::FAILED];

    protected $guarded = ['id'];

    protected $attributes = ['revision' => 1, 'status' => self::DRAFT, 'recipients_count' => 0, 'sent_count' => 0, 'failed_count' => 0, 'skipped_count' => 0];

    protected function casts(): array
    {
        return [
            'audience' => 'array', 'estimate' => 'array', 'scheduled_at' => 'datetime', 'started_at' => 'datetime',
            'finished_at' => 'datetime', 'confirmed_at' => 'datetime', 'cancelled_at' => 'datetime',
            'recipients_count' => 'integer', 'sent_count' => 'integer', 'failed_count' => 'integer', 'skipped_count' => 'integer',
            'revision' => 'integer',
        ];
    }
}
