<?php

declare(strict_types=1);

namespace App\Domain\Pos\Models;

use App\Domain\Inventory\Models\Location;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A till at an 8.8c location (PHASE-8-8D §3.1, §4, P88D-4). Store-scoped [S]. Written only by PosRegisterService;
 * nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $location_id
 * @property string $name
 * @property int $position
 * @property Carbon|null $archived_at
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Location $location
 */
class PosRegister extends Model
{
    use BelongsToTenant, HasUlids;

    public const NAME_MAX = 40;

    protected $fillable = [];

    protected $attributes = ['position' => 0];

    protected function casts(): array
    {
        return ['position' => 'integer', 'archived_at' => 'datetime'];
    }

    public function isArchived(): bool
    {
        return $this->archived_at !== null;
    }

    public function location(): BelongsTo
    {
        return $this->belongsTo(Location::class, 'location_id');
    }
}
