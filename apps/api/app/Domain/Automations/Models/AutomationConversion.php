<?php

declare(strict_types=1);

namespace App\Domain\Automations\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A recovered order (P86-15): one row per order (unique order_id), credited to the last message step `done` before the
 * order. Revenue is read later from the order (cancelled excluded).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $automation_id
 * @property string|null $run_id
 * @property string|null $step_id
 * @property string $order_id
 * @property Carbon $placed_at
 * @property Carbon|null $created_at
 */
class AutomationConversion extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['placed_at' => 'datetime'];
    }
}
