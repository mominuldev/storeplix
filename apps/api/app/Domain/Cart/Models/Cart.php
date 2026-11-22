<?php

namespace App\Domain\Cart\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * Guest cart (P5-3, ADR 0006). Identified by sha256(token); the raw token is returned once and never stored or logged.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $token_hash
 * @property string $status
 * @property string|null $coupon_code
 * @property string $currency
 * @property Carbon $last_activity_at
 * @property string|null $converted_order_id
 * @property string|null $ip
 */
class Cart extends Model
{
    use BelongsToTenant, HasUlids;

    public const ACTIVE = 'active';

    public const CONVERTED = 'converted';

    public const ABANDONED = 'abandoned';

    public const MAX_LINES = 50;

    public const MAX_QUANTITY = 99;

    public const TTL_DAYS = 30;

    protected $fillable = [];

    protected $hidden = ['token_hash'];

    protected $attributes = ['status' => self::ACTIVE];

    protected function casts(): array
    {
        return ['last_activity_at' => 'datetime'];
    }

    public function items(): HasMany
    {
        return $this->hasMany(CartItem::class)->orderBy('created_at')->orderBy('id');
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }
}
