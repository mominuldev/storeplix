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
 * @property int|null $price_yearly_amount
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

    public const MONTH = 'month';

    public const YEAR = 'year';

    public const INTERVALS = [self::MONTH, self::YEAR];

    public function isFree(): bool
    {
        return $this->code === self::FREE || $this->price_amount === 0;
    }

    /** Price of one period of this plan (P7-3), null when the plan has no such interval (Free yearly). */
    public function priceFor(string $interval): ?int
    {
        return match ($interval) {
            self::MONTH => $this->price_amount,
            self::YEAR => $this->price_yearly_amount,
            default => null,
        };
    }

    public static function free(): self
    {
        return self::query()->where('code', self::FREE)->firstOrFail();
    }

    protected $fillable = ['code', 'name', 'price_amount', 'price_yearly_amount', 'currency', 'interval', 'limits', 'features', 'is_active', 'sort'];

    protected function casts(): array
    {
        return [
            'price_amount' => 'integer',
            'price_yearly_amount' => 'integer',
            'limits' => 'array',
            'features' => 'array',
            'is_active' => 'boolean',
            'sort' => 'integer',
        ];
    }
}
