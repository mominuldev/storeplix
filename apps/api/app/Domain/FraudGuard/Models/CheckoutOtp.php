<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A shopper checkout code (P88-13): HMAC-SHA256 of the 6 digits, 5-minute TTL, 5 attempts. Pruned after 24 h.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $phone
 * @property string $code_hash
 * @property int $attempts
 * @property Carbon $sent_at
 * @property Carbon $expires_at
 * @property Carbon|null $verified_at
 * @property string|null $ip
 */
class CheckoutOtp extends Model
{
    use BelongsToTenant, HasUlids;

    public $timestamps = false;

    protected $fillable = [];

    protected $hidden = ['code_hash'];

    protected function casts(): array
    {
        return ['attempts' => 'integer', 'sent_at' => 'datetime', 'expires_at' => 'datetime', 'verified_at' => 'datetime'];
    }
}
