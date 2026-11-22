<?php

namespace App\Domain\Customers\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $customer_id
 * @property string $body
 * @property string|null $author_user_id
 * @property Carbon $created_at
 * @property-read User|null $author
 */
class CustomerNote extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = ['body'];

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }

    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'author_user_id');
    }
}
