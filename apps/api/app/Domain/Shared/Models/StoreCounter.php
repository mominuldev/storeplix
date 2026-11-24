<?php

namespace App\Domain\Shared\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/**
 * Per-store sequence (P5-16). Only written by next(): one atomic upsert, so the value is taken inside the caller's
 * transaction and a rolled-back transaction leaves no gap.
 *
 * @property string $tenant_id
 * @property string $store_id
 * @property string $key
 * @property int $value
 */
class StoreCounter extends Model
{
    use BelongsToTenant;

    public const ORDERS = 'orders';

    public const RETURNS = 'returns';

    public const PURCHASE_ORDERS = 'purchase_orders'; // PHASE-8-8B P88B-3: `PO-{n}` per store, from 1

    public const START = [self::ORDERS => 1001, self::RETURNS => 1, self::PURCHASE_ORDERS => 1];

    public $incrementing = false;

    protected $primaryKey = 'store_id';

    protected $keyType = 'string';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['value' => 'integer'];
    }

    /** Next value of the counter (first call returns the start value). Must run inside the caller's transaction. */
    public static function next(string $storeId, string $key): int
    {
        $now = now();
        $row = DB::selectOne(
            'INSERT INTO store_counters (tenant_id, store_id, "key", "value", created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) '
            .'ON CONFLICT (store_id, "key") DO UPDATE SET "value" = store_counters."value" + 1, updated_at = excluded.updated_at '
            .'RETURNING "value"',
            [app(TenantContext::class)->requireId(), $storeId, $key, self::START[$key] ?? 1, $now, $now],
        );

        return (int) $row->value;
    }

    /** Current value without changing it (null before the first order). */
    public static function current(string $storeId, string $key): ?int
    {
        $value = self::query()->where('store_id', $storeId)->where('key', $key)->value('value');

        return $value === null ? null : (int) $value;
    }
}
