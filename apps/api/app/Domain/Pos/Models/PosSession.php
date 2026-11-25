<?php

declare(strict_types=1);

namespace App\Domain\Pos\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Models\Location;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One register from open to close (PHASE-8-8D §3.1, §4, P88D-5, P88D-15). Store-scoped [S]. The expected cash in
 * the drawer is never stored mid-session: it is computed from the session's payment rows (§6.2) and frozen at close.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $register_id
 * @property string $location_id
 * @property string $status
 * @property string $currency
 * @property string $opened_by
 * @property Carbon $opened_at
 * @property int $opening_cash_amount
 * @property array<string, int>|null $opening_counts
 * @property string|null $closed_by
 * @property Carbon|null $closed_at
 * @property int|null $counted_cash_amount
 * @property array<string, int>|null $closing_counts
 * @property int|null $expected_cash_amount
 * @property int|null $variance_amount
 * @property int|null $left_in_drawer_amount
 * @property int|null $banked_amount
 * @property string|null $close_note
 * @property int $revision
 * @property-read PosRegister $register
 * @property-read Location $location
 * @property-read User $openedBy
 * @property-read User|null $closedBy
 */
class PosSession extends Model
{
    use BelongsToTenant, HasUlids;

    public const OPEN = 'open';

    public const CLOSED = 'closed';

    protected $fillable = [];

    protected $attributes = ['status' => self::OPEN, 'revision' => 1, 'opening_cash_amount' => 0];

    protected function casts(): array
    {
        return [
            'opened_at' => 'datetime', 'closed_at' => 'datetime', 'opening_cash_amount' => 'integer',
            'opening_counts' => 'array', 'closing_counts' => 'array', 'counted_cash_amount' => 'integer',
            'expected_cash_amount' => 'integer', 'variance_amount' => 'integer', 'left_in_drawer_amount' => 'integer',
            'banked_amount' => 'integer', 'revision' => 'integer',
        ];
    }

    public function isOpen(): bool
    {
        return $this->status === self::OPEN;
    }

    public function register(): BelongsTo
    {
        return $this->belongsTo(PosRegister::class, 'register_id');
    }

    public function location(): BelongsTo
    {
        return $this->belongsTo(Location::class, 'location_id');
    }

    public function openedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'opened_by');
    }

    public function closedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'closed_by');
    }
}
