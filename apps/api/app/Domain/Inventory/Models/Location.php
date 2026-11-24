<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A stock location of the store: a warehouse or a shop (PHASE-8-8C §3.1, P88C-2). Store-scoped [S]. Exactly one
 * default per store (= the online location, P88C-4); a default is never archived. Nothing is mass-assignable:
 * LocationService maps validated fields.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $name
 * @property string $type
 * @property string|null $address
 * @property string|null $pickup_location_id
 * @property bool $is_default
 * @property int $position
 * @property Carbon|null $archived_at
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read PickupLocation|null $pickupLocation
 */
class Location extends Model
{
    use BelongsToTenant, HasUlids;

    public const TYPES = ['warehouse', 'shop'];

    /** P88C-2: at most 10 non-archived locations per store. */
    public const MAX_ACTIVE = 10;

    public const DEFAULT_NAME = 'Main warehouse';

    protected $fillable = [];

    protected $attributes = ['is_default' => false, 'position' => 0, 'type' => 'warehouse'];

    protected function casts(): array
    {
        return ['is_default' => 'boolean', 'position' => 'integer', 'archived_at' => 'datetime'];
    }

    public function isArchived(): bool
    {
        return $this->archived_at !== null;
    }

    public function pickupLocation(): BelongsTo
    {
        return $this->belongsTo(PickupLocation::class, 'pickup_location_id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /** @return array{id: string, name: string} LocationRef */
    public function ref(): array
    {
        return ['id' => $this->id, 'name' => $this->name];
    }
}
