<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Models;

use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * A merchant webhook endpoint (PHASE-8-4 §5.1, P84-7): store-scoped, ≤ 5 per store (P84-14). `events` holds
 * WebhookEventType values (never `ping`). Nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $url
 * @property string|null $description
 * @property list<string> $events
 * @property bool $is_active
 * @property string|null $disabled_reason
 * @property Carbon|null $failing_since
 * @property Carbon|null $last_delivery_at
 * @property int|null $last_status
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class WebhookEndpoint extends Model
{
    use BelongsToTenant, HasUlids;

    public const DISABLED_MANUAL = 'manual';

    public const DISABLED_FAILING = 'failing';

    protected $fillable = [];

    protected $attributes = ['events' => '[]', 'is_active' => true];

    protected function casts(): array
    {
        return [
            'events' => 'array',
            'is_active' => 'boolean',
            'failing_since' => 'datetime',
            'last_delivery_at' => 'datetime',
            'last_status' => 'integer',
        ];
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function deliveries(): HasMany
    {
        return $this->hasMany(WebhookDelivery::class, 'endpoint_id');
    }

    public function subscribes(string $eventType): bool
    {
        return in_array($eventType, $this->events ?? [], true);
    }
}
