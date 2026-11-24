<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One payment the merchant made outside the order flow (PHASE-8-7 §4). Store-scoped [S]. Nothing is mass-assignable:
 * ExpenseService maps validated fields (S147: tenant_id, store_id, currency, created_by never come from input).
 * `spent_on` is a store-local calendar date kept as a `Y-m-d` string (no cast: a date cast would store a time part
 * on sqlite and break the `(recurrence_id, spent_on)` uniqueness and the range filters).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $category
 * @property string $paid_from
 * @property int $amount
 * @property string $currency
 * @property string $spent_on
 * @property string|null $note
 * @property string|null $receipt_media_id
 * @property string|null $recurrence_id
 * @property string|null $created_by
 * @property string|null $updated_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Expense extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected function casts(): array
    {
        return ['amount' => 'integer'];
    }

    /** `Y-m-d` whatever the driver returns (Postgres date, sqlite text). */
    public function spentOn(): string
    {
        return substr((string) $this->spent_on, 0, 10);
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function receipt(): BelongsTo
    {
        return $this->belongsTo(Media::class, 'receipt_media_id');
    }

    public function recurrence(): BelongsTo
    {
        return $this->belongsTo(ExpenseRecurrence::class, 'recurrence_id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
