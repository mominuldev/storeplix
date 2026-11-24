<?php

declare(strict_types=1);

namespace App\Domain\Inventory\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * A stock transfer `TR-{n}` between two locations of a store (PHASE-8-8C §3.2, §7, P88C-9). Store-scoped [S]. Written
 * only by StockTransferService under a row lock; stock moves only through InventoryService. Nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property int $sequence
 * @property string $number
 * @property string $from_location_id
 * @property string $to_location_id
 * @property string $status
 * @property string|null $note
 * @property Carbon|null $sent_at
 * @property string|null $sent_by
 * @property Carbon|null $received_at
 * @property string|null $received_by
 * @property Carbon|null $cancelled_at
 * @property string|null $cancelled_by
 * @property int $items_count
 * @property int $units_sent
 * @property int $units_received
 * @property int $units_short
 * @property int $revision
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Location $fromLocation
 * @property-read Location $toLocation
 */
class StockTransfer extends Model
{
    use BelongsToTenant, HasUlids;

    public const DRAFT = 'draft';

    public const IN_TRANSIT = 'in_transit';

    public const RECEIVED = 'received';

    public const CANCELLED = 'cancelled';

    public const STATUSES = [self::DRAFT, self::IN_TRANSIT, self::RECEIVED, self::CANCELLED];

    /** Open = blocks archiving either location (P88C-17 `open_transfers`). */
    public const OPEN = [self::DRAFT, self::IN_TRANSIT];

    public const MAX_LINES = 200;

    public const MAX_QUANTITY = 100000;

    protected $fillable = [];

    protected $attributes = ['status' => self::DRAFT, 'items_count' => 0, 'units_sent' => 0, 'units_received' => 0, 'units_short' => 0, 'revision' => 1];

    protected function casts(): array
    {
        return [
            'sequence' => 'integer', 'items_count' => 'integer', 'units_sent' => 'integer', 'units_received' => 'integer',
            'units_short' => 'integer', 'revision' => 'integer', 'sent_at' => 'datetime', 'received_at' => 'datetime',
            'cancelled_at' => 'datetime',
        ];
    }

    /** "TR-021": 3-digit padded per-store sequence. */
    public static function numberFor(int $sequence): string
    {
        return 'TR-'.str_pad((string) $sequence, 3, '0', STR_PAD_LEFT);
    }

    public function items(): HasMany
    {
        return $this->hasMany(StockTransferItem::class, 'stock_transfer_id')->orderBy('position')->orderBy('id');
    }

    public function fromLocation(): BelongsTo
    {
        return $this->belongsTo(Location::class, 'from_location_id');
    }

    public function toLocation(): BelongsTo
    {
        return $this->belongsTo(Location::class, 'to_location_id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
