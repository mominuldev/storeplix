<?php

declare(strict_types=1);

namespace App\Domain\Sms\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A tenant's SMS credits (PHASE-8-9A §3.1, P89A-5). Tenant-level [T]. Written only by SmsCreditService / SmsCharger
 * under a `FOR UPDATE` row lock; the balance always equals the ledger sum. Nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property int $balance
 * @property int $purchased_total
 * @property int|null $low_credit_threshold
 * @property Carbon|null $low_alert_sent_at
 * @property Carbon|null $last_purchase_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class SmsCreditAccount extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected $attributes = ['balance' => 0, 'purchased_total' => 0];

    protected function casts(): array
    {
        return [
            'balance' => 'integer',
            'purchased_total' => 'integer',
            'low_credit_threshold' => 'integer',
            'low_alert_sent_at' => 'datetime',
            'last_purchase_at' => 'datetime',
        ];
    }
}
