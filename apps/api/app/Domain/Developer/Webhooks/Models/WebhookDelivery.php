<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One delivery of one event to one endpoint (PHASE-8-4 §4.4). `payload` is the full §4.2 body, stored once and sent
 * unchanged on every attempt and resend. Nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $endpoint_id
 * @property string $event_id
 * @property string $event_type
 * @property string|null $subject_type
 * @property string|null $subject_id
 * @property string|null $subject_label
 * @property array<string, mixed> $payload
 * @property string $status
 * @property int $attempts
 * @property Carbon|null $next_attempt_at
 * @property Carbon|null $last_attempt_at
 * @property int|null $response_status
 * @property string|null $response_body_excerpt
 * @property string|null $error_code
 * @property int|null $duration_ms
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class WebhookDelivery extends Model
{
    use BelongsToTenant, HasUlids;

    public const PENDING = 'pending';

    public const RETRYING = 'retrying';

    public const SUCCEEDED = 'succeeded';

    public const FAILED = 'failed';

    public const STATUSES = [self::PENDING, self::RETRYING, self::SUCCEEDED, self::FAILED];

    /** Not final: the job (or the minute sweep) still has work. */
    public const OPEN = [self::PENDING, self::RETRYING];

    public const ERROR_TIMEOUT = 'timeout';

    public const ERROR_CONNECTION = 'connection_failed';

    public const ERROR_URL = 'url_not_allowed';

    public const ERROR_HTTP = 'http_error';

    public const ERROR_PLAN = 'plan';

    public const ERROR_DISABLED = 'endpoint_disabled';

    protected $fillable = [];

    protected $attributes = ['status' => self::PENDING, 'attempts' => 0];

    protected function casts(): array
    {
        return [
            'payload' => 'array',
            'attempts' => 'integer',
            'next_attempt_at' => 'datetime',
            'last_attempt_at' => 'datetime',
            'response_status' => 'integer',
            'duration_ms' => 'integer',
        ];
    }

    public function endpoint(): BelongsTo
    {
        return $this->belongsTo(WebhookEndpoint::class, 'endpoint_id');
    }
}
