<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A supplier of the store (PHASE-8-8B §3, §4). Store-scoped [S]. Nothing is mass-assignable: SupplierService maps
 * validated fields (tenant_id, store_id, created_by never come from input). `phone` is the normalised "8801XXXXXXXXX".
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $name
 * @property string|null $contact_name
 * @property string|null $phone
 * @property string|null $city
 * @property string|null $supplies
 * @property int|null $payment_terms_days
 * @property int|null $advance_percent
 * @property int|null $lead_time_days
 * @property string|null $pays_by_method
 * @property string|null $pays_by_account
 * @property string|null $notes
 * @property Carbon|null $archived_at
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Supplier extends Model
{
    use BelongsToTenant, HasUlids;

    /** The editable fields (SupplierRequest / the CSV import). */
    public const FIELDS = [
        'name', 'contact_name', 'phone', 'city', 'supplies', 'payment_terms_days', 'advance_percent', 'lead_time_days',
        'pays_by_method', 'pays_by_account', 'notes',
    ];

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'payment_terms_days' => 'integer',
            'advance_percent' => 'integer',
            'lead_time_days' => 'integer',
            'archived_at' => 'datetime',
        ];
    }

    public function isArchived(): bool
    {
        return $this->archived_at !== null;
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
