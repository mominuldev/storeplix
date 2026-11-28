<?php

declare(strict_types=1);

namespace App\Domain\Ai\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Append-only AI credit ledger row (PHASE-8-9D §3.2, P89D-34). `credits` is signed (consume < 0, refund > 0,
 * admin_adjust ≠ 0); `source` is allowance | bonus (null for admin_adjust); `period` is YYYY-MM in the store timezone.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $type
 * @property string|null $source
 * @property int $credits
 * @property int $bonus_after
 * @property string $period
 * @property string|null $ai_generation_id
 * @property string|null $reason
 * @property string $actor_type
 * @property string|null $actor_user_id
 * @property string|null $idempotency_key
 * @property string|null $request_hash
 * @property Carbon $created_at
 * @property-read AiGeneration|null $generation
 */
class AiCreditLedgerEntry extends Model
{
    use BelongsToTenant, HasUlids;

    public const CONSUME = 'consume';

    public const REFUND = 'refund';

    public const ADMIN_ADJUST = 'admin_adjust';

    public const TYPES = [self::CONSUME, self::REFUND, self::ADMIN_ADJUST];

    public const ALLOWANCE = 'allowance';

    public const BONUS = 'bonus';

    public const UPDATED_AT = null;

    protected $table = 'ai_credit_ledger';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['credits' => 'integer', 'bonus_after' => 'integer', 'created_at' => 'datetime'];
    }

    public function generation(): BelongsTo
    {
        return $this->belongsTo(AiGeneration::class, 'ai_generation_id');
    }
}
