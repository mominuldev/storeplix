<?php

namespace App\Domain\Billing\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;

/**
 * Platform reference data (not tenant-scoped).
 *
 * @property string $id
 * @property string $code
 * @property string $name
 * @property int $price_amount
 * @property string $currency
 * @property string $interval
 * @property array<string, int|null> $limits
 * @property list<string> $features
 * @property bool $is_active
 * @property int $sort
 */
class Plan extends Model
{
    use HasUlids;

    public const FREE = 'free';

    public const STARTER = 'starter';

    public const GROWTH = 'growth';

    protected $fillable = ['code', 'name', 'price_amount', 'currency', 'interval', 'limits', 'features', 'is_active', 'sort'];

    protected function casts(): array
    {
        return [
            'price_amount' => 'integer',
            'limits' => 'array',
            'features' => 'array',
            'is_active' => 'boolean',
            'sort' => 'integer',
        ];
    }
}
