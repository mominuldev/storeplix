<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * The store's guard rules (PHASE-8-8 §4, one row per store, created lazily with the defaults by GuardSettings).
 * Nothing is mass-assignable: GuardSettings::update maps validated keys.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property bool $enabled
 * @property bool $hold_enabled
 * @property int $hold_below
 * @property bool $advance_enabled
 * @property int $advance_below
 * @property int $advance_expiry_minutes
 * @property bool $advance_cancel_if_unpaid
 * @property bool $otp_enabled
 * @property bool $block_returners
 * @property int $block_after_returns
 * @property bool $duplicates_enabled
 * @property int $duplicate_window_hours
 * @property bool $daily_limit_enabled
 * @property int $daily_limit
 * @property int $min_parcels
 * @property string|null $updated_by
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 */
class FraudGuardSetting extends Model
{
    use BelongsToTenant, HasUlids;

    public const BOOLEANS = ['enabled', 'hold_enabled', 'advance_enabled', 'advance_cancel_if_unpaid', 'otp_enabled', 'block_returners', 'duplicates_enabled', 'daily_limit_enabled'];

    public const INTEGERS = ['hold_below', 'advance_below', 'advance_expiry_minutes', 'block_after_returns', 'duplicate_window_hours', 'daily_limit', 'min_parcels'];

    protected $fillable = [];

    protected function casts(): array
    {
        $casts = [];
        foreach (self::BOOLEANS as $key) {
            $casts[$key] = 'boolean';
        }
        foreach (self::INTEGERS as $key) {
            $casts[$key] = 'integer';
        }

        return $casts;
    }

    public function updatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }
}
