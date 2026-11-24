<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One explained risk check per order (PHASE-8-8 §4, §5.2): the own-shop numbers it used, the tier, the reasons and the
 * decision. Written once by CheckOrderRisk; only `released_at`/`released_by` change later.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $order_id
 * @property string $phone
 * @property string $tier
 * @property int|null $rate
 * @property int $delivered
 * @property int $total
 * @property int $shop_delivered
 * @property int $shop_total
 * @property list<string> $reasons
 * @property string $decision
 * @property bool $with_actions
 * @property string|null $duplicate_of
 * @property string|null $payment_link_id
 * @property Carbon|null $released_at
 * @property string|null $released_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class OrderRiskCheck extends Model
{
    use BelongsToTenant, HasUlids;

    public const NONE = 'none';

    public const HOLD = 'hold';

    public const ADVANCE = 'advance';

    public const SKIPPED = 'skipped';

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'rate' => 'integer', 'delivered' => 'integer', 'total' => 'integer', 'shop_delivered' => 'integer',
            'shop_total' => 'integer', 'reasons' => 'array', 'with_actions' => 'boolean', 'released_at' => 'datetime',
        ];
    }
}
