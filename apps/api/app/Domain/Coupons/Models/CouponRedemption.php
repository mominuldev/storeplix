<?php

namespace App\Domain\Coupons\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;

/**
 * One coupon use by one order (P5-13). `released` when the order is cancelled.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $coupon_id
 * @property string $order_id
 * @property string $customer_phone
 * @property int $discount_amount
 * @property string $status
 */
class CouponRedemption extends Model
{
    use BelongsToTenant, HasUlids;

    public const ACTIVE = 'active';

    public const RELEASED = 'released';

    protected $fillable = [];

    protected $attributes = ['status' => self::ACTIVE];

    protected function casts(): array
    {
        return ['discount_amount' => 'integer'];
    }
}
