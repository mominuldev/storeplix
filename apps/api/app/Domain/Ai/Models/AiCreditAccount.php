<?php

declare(strict_types=1);

namespace App\Domain\Ai\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One per tenant (PHASE-8-9D §3.2): the staff-granted bonus balance. Created lazily and locked FOR UPDATE by every
 * charge, refund and adjustment (AiCreditCharger). Nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property int $bonus_balance
 * @property Carbon|null $last_adjusted_at
 */
class AiCreditAccount extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['bonus_balance' => 'integer', 'last_adjusted_at' => 'datetime'];
    }
}
