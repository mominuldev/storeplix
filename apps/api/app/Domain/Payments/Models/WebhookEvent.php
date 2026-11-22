<?php

declare(strict_types=1);

namespace App\Domain\Payments\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * An inbound gateway/courier event (P5B-19, S24): deduplicated by U(tenant_id, provider, event_id); `payload` is
 * scrubbed (PayloadScrubber). `account_id` is a soft reference to a payment_gateway_accounts / courier_accounts row.
 * No created_at/updated_at: received_at / processed_at. Retention 90 days.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $provider
 * @property string $account_id
 * @property string $event_id
 * @property string|null $event_type
 * @property array<string, mixed> $payload
 * @property string $status
 * @property int $attempts
 * @property string|null $error_code
 * @property Carbon $received_at
 * @property Carbon|null $processed_at
 */
class WebhookEvent extends Model
{
    use BelongsToTenant, HasUlids;

    public const RECEIVED = 'received';

    public const PROCESSED = 'processed';

    public const IGNORED = 'ignored';

    public const FAILED = 'failed';

    public $timestamps = false;

    protected $fillable = [];

    protected $attributes = ['status' => self::RECEIVED, 'attempts' => 0];

    protected function casts(): array
    {
        return [
            'payload' => 'array',
            'attempts' => 'integer',
            'received_at' => 'datetime',
            'processed_at' => 'datetime',
        ];
    }
}
