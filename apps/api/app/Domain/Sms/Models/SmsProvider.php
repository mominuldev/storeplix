<?php

declare(strict_types=1);

namespace App\Domain\Sms\Models;

use App\Domain\Identity\Models\User;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9B §3.1: one platform SMS provider (platform table, no tenant). `credentials_encrypted` is
 * integration-credentials ciphertext, hidden and never mass-assigned from input (S220). Reads: default connection (app
 * role SELECT); writes: the admin connection (SmsProviderService::query()).
 *
 * @property string $id
 * @property string $driver
 * @property string $name
 * @property string $role draft|primary|failover|inactive|removed
 * @property string|null $credentials_encrypted
 * @property array<string, string> $credentials_hint
 * @property array<string, mixed> $settings
 * @property string $default_sender_id
 * @property string|null $promotional_sender_id
 * @property string|null $promotional_sender_status
 * @property list<string> $message_groups
 * @property int $rate_limit_per_minute
 * @property int $failover_after_failures
 * @property int $failover_timeout_seconds
 * @property int|null $price_masking_paisa
 * @property int|null $price_non_masking_paisa
 * @property int|null $balance_amount
 * @property Carbon|null $balance_fetched_at
 * @property string|null $balance_status
 * @property int $balance_failures
 * @property int|null $low_threshold_paisa
 * @property bool $alert_email
 * @property bool $alert_in_app
 * @property Carbon|null $low_balance_alerted_at
 * @property Carbon $connection_changed_at
 * @property Carbon|null $last_test_at
 * @property string|null $last_test_status
 * @property string|null $last_test_error_code
 * @property string|null $last_test_by
 * @property Carbon|null $credentials_rotated_at
 * @property string|null $credentials_rotated_by
 * @property Carbon|null $activated_at
 * @property string|null $activated_by
 * @property Carbon|null $removed_at
 * @property string|null $removed_by
 * @property string|null $created_by
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class SmsProvider extends Model
{
    use HasUlids;

    public const DRAFT = 'draft';

    public const PRIMARY = 'primary';

    public const FAILOVER = 'failover';

    public const INACTIVE = 'inactive';

    public const REMOVED = 'removed';

    public const ROLES = [self::DRAFT, self::PRIMARY, self::FAILOVER, self::INACTIVE, self::REMOVED];

    public const PASSED = 'passed';

    public const FAILED = 'failed';

    protected $guarded = ['id', 'credentials_encrypted'];

    protected $hidden = ['credentials_encrypted'];

    protected $attributes = ['credentials_hint' => '{}', 'revision' => 1, 'balance_failures' => 0];

    protected function casts(): array
    {
        return [
            'credentials_hint' => 'array', 'settings' => 'array', 'message_groups' => 'array',
            'rate_limit_per_minute' => 'integer', 'failover_after_failures' => 'integer', 'failover_timeout_seconds' => 'integer',
            'price_masking_paisa' => 'integer', 'price_non_masking_paisa' => 'integer', 'balance_amount' => 'integer',
            'balance_failures' => 'integer', 'low_threshold_paisa' => 'integer', 'alert_email' => 'boolean', 'alert_in_app' => 'boolean',
            'balance_fetched_at' => 'datetime', 'low_balance_alerted_at' => 'datetime', 'connection_changed_at' => 'datetime',
            'last_test_at' => 'datetime', 'credentials_rotated_at' => 'datetime', 'activated_at' => 'datetime', 'removed_at' => 'datetime',
            'revision' => 'integer',
        ];
    }

    /** §3.1: activation needs a passed test after the last connection change. */
    public function testRequired(): bool
    {
        return $this->last_test_status !== self::PASSED || $this->last_test_at === null
            || ($this->connection_changed_at !== null && $this->last_test_at->lt($this->connection_changed_at));
    }

    public function carries(string $group): bool
    {
        return in_array($group, (array) $this->message_groups, true);
    }

    /** @return BelongsTo<User, $this> */
    public function lastTestBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'last_test_by');
    }

    /** @return BelongsTo<User, $this> */
    public function rotatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'credentials_rotated_by');
    }
}
