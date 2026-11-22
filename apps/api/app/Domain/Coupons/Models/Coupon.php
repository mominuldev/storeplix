<?php

namespace App\Domain\Coupons\Models;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Support\Carbon;

/**
 * Coupon (P5-11). used_count / revision / created_by are never mass-assignable; used_count changes only inside the
 * order transaction (OrderPlacementService / OrderService) under a row lock.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $code
 * @property string $type
 * @property int|null $percent_bps
 * @property int|null $amount
 * @property int|null $max_discount_amount
 * @property string $applies_to
 * @property int|null $min_subtotal_amount
 * @property int|null $usage_limit
 * @property int|null $usage_per_customer
 * @property bool $first_order_only
 * @property Carbon $starts_at
 * @property Carbon|null $ends_at
 * @property string $status
 * @property int $used_count
 * @property int $revision
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Coupon extends Model
{
    use BelongsToTenant, HasUlids;

    public const PERCENTAGE = 'percentage';

    public const FIXED = 'fixed';

    public const FREE_SHIPPING = 'free_shipping';

    public const TYPES = [self::PERCENTAGE, self::FIXED, self::FREE_SHIPPING];

    public const STATUSES = ['draft', 'active', 'disabled'];

    public const DISPLAY_STATUSES = ['draft', 'active', 'disabled', 'scheduled', 'expired', 'used_up'];

    public const CODE_PATTERN = '/^[A-Z0-9][A-Z0-9_-]{2,31}$/';

    protected $fillable = [
        'code', 'type', 'percent_bps', 'amount', 'max_discount_amount', 'applies_to', 'min_subtotal_amount',
        'usage_limit', 'usage_per_customer', 'first_order_only', 'starts_at', 'ends_at', 'status',
    ];

    protected $attributes = ['applies_to' => 'all', 'first_order_only' => false, 'status' => 'draft', 'used_count' => 0, 'revision' => 1];

    protected function casts(): array
    {
        return [
            'percent_bps' => 'integer',
            'amount' => 'integer',
            'max_discount_amount' => 'integer',
            'min_subtotal_amount' => 'integer',
            'usage_limit' => 'integer',
            'usage_per_customer' => 'integer',
            'first_order_only' => 'boolean',
            'starts_at' => 'datetime',
            'ends_at' => 'datetime',
            'used_count' => 'integer',
            'revision' => 'integer',
        ];
    }

    /** Derived display status (P5-11): draft / disabled as stored; active splits into scheduled / expired / used_up. */
    public function displayStatus(?Carbon $now = null): string
    {
        $now ??= now();

        return match (true) {
            $this->status !== 'active' => $this->status,
            $this->ends_at !== null && $this->ends_at->lte($now) => 'expired',
            $this->usage_limit !== null && $this->used_count >= $this->usage_limit => 'used_up',
            $this->starts_at->gt($now) => 'scheduled',
            default => 'active',
        };
    }

    public function categories(): BelongsToMany
    {
        return $this->belongsToMany(Category::class, 'coupon_categories');
    }

    public function products(): BelongsToMany
    {
        return $this->belongsToMany(Product::class, 'coupon_products')->withTrashed();
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
