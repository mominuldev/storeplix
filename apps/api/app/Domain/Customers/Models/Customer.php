<?php

namespace App\Domain\Customers\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Customer (P4-16). orders_count / total_spent_amount / last_order_at / source / revision are never mass-assignable
 * (Phase 5 order code writes the order stats).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $name
 * @property string|null $phone
 * @property string|null $email
 * @property string|null $district
 * @property string|null $area
 * @property string|null $channel
 * @property string $source
 * @property list<string> $tags
 * @property bool $accepts_marketing
 * @property int $orders_count
 * @property int $delivered_orders_count
 * @property int $returned_orders_count
 * @property int $total_spent_amount
 * @property Carbon|null $last_order_at
 * @property int $revision
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Customer extends Model
{
    use BelongsToTenant, HasUlids, SoftDeletes;

    public const CHANNELS = ['facebook', 'instagram', 'whatsapp', 'website', 'phone', 'walk_in', 'other'];

    public const SOURCE_MANUAL = 'manual';

    public const SOURCE_IMPORT = 'import';

    public const SOURCE_STOREFRONT = 'storefront';

    protected $fillable = ['name', 'phone', 'email', 'district', 'area', 'channel', 'tags', 'accepts_marketing'];

    protected $attributes = [
        'tags' => '[]', 'accepts_marketing' => false, 'source' => self::SOURCE_MANUAL, 'orders_count' => 0,
        'delivered_orders_count' => 0, 'returned_orders_count' => 0,
        'total_spent_amount' => 0, 'revision' => 1,
    ];

    protected function casts(): array
    {
        return [
            'tags' => 'array',
            'accepts_marketing' => 'boolean',
            'orders_count' => 'integer',
            'delivered_orders_count' => 'integer',
            'returned_orders_count' => 'integer',
            'total_spent_amount' => 'integer',
            'last_order_at' => 'datetime',
            'revision' => 'integer',
        ];
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function notes(): HasMany
    {
        return $this->hasMany(CustomerNote::class)->orderByDesc('created_at')->orderByDesc('id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
