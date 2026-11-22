<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Models;

use App\Domain\Orders\Models\Shipment;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;
use LogicException;

/**
 * Append-only shipment timeline row (§3 000900). Updates and deletes throw; rows go away only with their shipment
 * (FK cascade). Dedupe: U(shipment_id, provider_status, occurred_at).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $shipment_id
 * @property string $status
 * @property string|null $provider_status
 * @property string|null $description
 * @property string|null $location
 * @property string $source
 * @property Carbon $occurred_at
 * @property Carbon $created_at
 */
class ShipmentEvent extends Model
{
    use BelongsToTenant, HasUlids;

    public const WEBHOOK = 'webhook';

    public const POLL = 'poll';

    public const USER = 'user';

    public const SYSTEM = 'system';

    public const SOURCES = [self::WEBHOOK, self::POLL, self::USER, self::SYSTEM];

    public const UPDATED_AT = null;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['occurred_at' => 'datetime', 'created_at' => 'datetime'];
    }

    protected static function booted(): void
    {
        static::updating(fn () => throw new LogicException('shipment_events are append-only.'));
        static::deleting(fn () => throw new LogicException('shipment_events are append-only.'));
    }

    public function shipment(): BelongsTo
    {
        return $this->belongsTo(Shipment::class);
    }

    /** ShipmentEvent (types): `{ id, status, provider_status, description, location, source, occurred_at }`. */
    public function toContract(): array
    {
        return [
            'id' => $this->id,
            'status' => $this->status,
            'provider_status' => $this->provider_status,
            'description' => $this->description,
            'location' => $this->location,
            'source' => $this->source,
            'occurred_at' => $this->occurred_at->toIso8601ZuluString(),
        ];
    }
}
