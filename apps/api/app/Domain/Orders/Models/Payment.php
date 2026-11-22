<?php

namespace App\Domain\Orders\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Payment row (P5-18): the COD charge of an order, or a manual refund record. No money moves through Storeplix in 5a.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $order_id
 * @property string $provider
 * @property string $type
 * @property string $status
 * @property int $amount
 * @property string $currency
 * @property string|null $method
 * @property string|null $reference
 * @property string|null $note
 * @property string|null $parent_payment_id
 * @property string|null $idempotency_key
 * @property string|null $actor_user_id
 * @property Carbon $created_at
 * @property-read User|null $actor
 */
class Payment extends Model
{
    use BelongsToTenant, HasUlids;

    public const REFUND_METHODS = ['cash', 'bkash_personal', 'nagad_personal', 'bank', 'other'];

    protected $fillable = [];

    protected $hidden = ['raw'];

    protected function casts(): array
    {
        return ['amount' => 'integer', 'raw' => 'array', 'verified_at' => 'datetime'];
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_user_id');
    }
}
