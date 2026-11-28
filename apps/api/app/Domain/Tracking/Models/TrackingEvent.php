<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9D §3.1: one tracking event per (integration, event_id, channel) — the outbox row of a server send and the
 * event-log entry. `payload` holds hashed user data, IP and UA only until the row is final (P89D-18); it never holds a
 * token or secret (the driver adds those at send time from the integration row).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $store_integration_id
 * @property string $provider
 * @property string $event_name
 * @property string|null $provider_event_name
 * @property string $event_id
 * @property string $channel
 * @property string $source
 * @property bool $test
 * @property string|null $order_id
 * @property string|null $payment_id
 * @property string|null $page_path
 * @property int|null $value_amount
 * @property string|null $currency
 * @property string $status
 * @property string|null $skip_reason
 * @property int $attempts
 * @property Carbon|null $next_attempt_at
 * @property Carbon|null $last_attempt_at
 * @property int|null $http_status
 * @property string|null $error_code
 * @property array<string, mixed>|null $payload
 * @property Carbon|null $delivered_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class TrackingEvent extends Model
{
    use BelongsToTenant, HasUlids;

    public const PENDING = 'pending';

    public const RETRYING = 'retrying';

    public const DELIVERED = 'delivered';

    public const FAILED = 'failed';

    public const SKIPPED = 'skipped';

    public const OPEN = [self::PENDING, self::RETRYING];

    public const FINAL = [self::DELIVERED, self::FAILED, self::SKIPPED];

    public const BROWSER = 'browser';

    public const SERVER = 'server';

    protected $table = 'tracking_events';

    protected $fillable = [];

    protected $hidden = ['payload'];

    protected function casts(): array
    {
        return [
            'test' => 'boolean',
            'value_amount' => 'integer',
            'attempts' => 'integer',
            'http_status' => 'integer',
            'payload' => 'array',
            'next_attempt_at' => 'datetime',
            'last_attempt_at' => 'datetime',
            'delivered_at' => 'datetime',
        ];
    }
}
