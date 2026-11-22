<?php

namespace App\Domain\Inventory\Models;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;
use LogicException;

/**
 * Append-only stock ledger row. Updating or deleting a movement throws (rows only disappear with their
 * variant/tenant through FK cascades). Written only by InventoryService.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $variant_id
 * @property int $delta
 * @property int $on_hand_after
 * @property string $reason
 * @property string|null $note
 * @property string|null $reference_type
 * @property string|null $reference_id
 * @property string|null $actor_user_id
 * @property Carbon $created_at
 * @property-read ProductVariant|null $variant
 * @property-read User|null $actor
 */
class InventoryMovement extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    public const REASONS = ['initial', 'received', 'correction', 'damaged', 'lost', 'returned', 'import', 'other'];

    public const MANUAL_REASONS = ['received', 'correction', 'damaged', 'lost', 'returned', 'other'];

    protected $fillable = [];

    protected function casts(): array
    {
        return ['delta' => 'integer', 'on_hand_after' => 'integer', 'created_at' => 'datetime'];
    }

    protected static function booted(): void
    {
        static::updating(fn () => throw new LogicException('Inventory movements are append-only.'));
        static::deleting(fn () => throw new LogicException('Inventory movements are append-only.'));
    }

    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'variant_id')->withTrashed();
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_user_id');
    }
}
