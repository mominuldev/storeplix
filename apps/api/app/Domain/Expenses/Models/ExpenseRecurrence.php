<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A "Repeat every month" series (PHASE-8-7 P87-9, §6.2). `next_on` is a store-local `Y-m-d` string (see Expense).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property int $day_of_month
 * @property string $next_on
 * @property string $status active|stopped
 * @property Carbon|null $stopped_at
 * @property string|null $created_by
 */
class ExpenseRecurrence extends Model
{
    use BelongsToTenant, HasUlids;

    public const ACTIVE = 'active';

    public const STOPPED = 'stopped';

    protected $fillable = [];

    protected $attributes = ['status' => self::ACTIVE];

    protected function casts(): array
    {
        return ['day_of_month' => 'integer', 'stopped_at' => 'datetime'];
    }

    public function nextOn(): string
    {
        return substr((string) $this->next_on, 0, 10);
    }

    public function isActive(): bool
    {
        return $this->status === self::ACTIVE;
    }
}
