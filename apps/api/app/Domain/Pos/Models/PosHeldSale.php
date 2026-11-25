<?php

declare(strict_types=1);

namespace App\Domain\Pos\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A parked sale of a register (PHASE-8-8D §3.1, §9, P88D-16). Reserves no stock: lines are variant ids + quantities,
 * re-priced and re-checked when resumed. Deleted when the sale that resumes it completes, by hand, or when the register
 * closes. Store-scoped [S]; insert / delete only.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $register_id
 * @property string|null $session_id
 * @property string|null $customer_id
 * @property string|null $customer_name
 * @property string|null $customer_phone
 * @property string|null $coupon_code
 * @property string|null $note
 * @property list<array{variant_id: string, quantity: int}> $lines
 * @property int $items_count
 * @property int $total_amount
 * @property string $currency
 * @property string $held_by
 * @property Carbon $created_at
 * @property-read User $heldBy
 */
class PosHeldSale extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    /** P88D-16: held sales per register. */
    public const MAX_PER_REGISTER = 20;

    public const NOTE_MAX = 120;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['lines' => 'array', 'items_count' => 'integer', 'total_amount' => 'integer', 'created_at' => 'datetime'];
    }

    public function heldBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'held_by');
    }
}
