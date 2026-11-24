<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Models;

use App\Domain\Customers\Models\Customer;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A phone that can't place COD orders at this store (P88-9). An unblock sets `unblocked_at` (the row stays: P88-10
 * never re-adds an automatic block the merchant removed).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $phone
 * @property string|null $customer_id
 * @property string $reason
 * @property string|null $note
 * @property string $source
 * @property string|null $created_by
 * @property Carbon|null $unblocked_at
 * @property string|null $unblocked_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class BlockedPhone extends Model
{
    use BelongsToTenant, HasUlids;

    public const MANUAL = 'manual';

    public const REPEAT_RETURNS = 'repeat_returns';

    public const STAFF = 'staff';

    public const AUTO = 'auto';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['unblocked_at' => 'datetime'];
    }

    /** @param Builder<self> $query */
    public function scopeActive(Builder $query): void
    {
        $query->whereNull('unblocked_at');
    }

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class)->withTrashed();
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
