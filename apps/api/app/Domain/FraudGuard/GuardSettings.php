<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\FraudGuard\Models\FraudGuardSetting;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The store's guard rules (PHASE-8-8 §4, §6.1). Registered as a SCOPED instance (reset per request and per queued
 * job), so the per-store memo never outlives the unit of work that read it. Call inside the tenant context.
 *
 * "Guarded store" = the plan has `fake_order_guard` (P88-15) AND `enabled`. Tiers and own-shop records ignore both.
 */
class GuardSettings
{
    /** The six built rules (§6.4 `rules_total`; courier-record and VPN rules are hidden). */
    public const RULES = ['hold_enabled', 'advance_enabled', 'otp_enabled', 'block_returners', 'duplicates_enabled', 'daily_limit_enabled'];

    public const EXPIRY_MINUTES = [120, 360, 1440, 2880];

    public const WINDOW_HOURS = [6, 12, 24, 48, 72];

    /** @var array<string, FraudGuardSetting> */
    private array $memo = [];

    public function __construct(private readonly TenantContext $context) {}

    /** §4 defaults ("Reset to recommended"); `enabled` follows config (production: on). @return array<string, bool|int> */
    public static function defaults(): array
    {
        return [
            'enabled' => (bool) config('fraud_guard.default_enabled', true),
            'hold_enabled' => true, 'hold_below' => 60,
            'advance_enabled' => true, 'advance_below' => 75, 'advance_expiry_minutes' => 1440, 'advance_cancel_if_unpaid' => true,
            'otp_enabled' => true,
            'block_returners' => true, 'block_after_returns' => 3,
            'duplicates_enabled' => true, 'duplicate_window_hours' => 24,
            'daily_limit_enabled' => true, 'daily_limit' => 3,
            'min_parcels' => 3,
        ];
    }

    /** The persisted row, or an unsaved one with the defaults (reads never write). */
    public function for(string $storeId): FraudGuardSetting
    {
        if (isset($this->memo[$storeId])) {
            return $this->memo[$storeId];
        }
        $row = FraudGuardSetting::query()->where('store_id', $storeId)->first();
        if ($row === null) {
            $row = new FraudGuardSetting;
            $row->store_id = $storeId;
            foreach (self::defaults() as $key => $value) {
                $row->{$key} = $value;
            }
        }

        return $this->memo[$storeId] = $row;
    }

    /** §4 "created lazily with defaults on first read" (GET settings). Race-safe on UNIQUE(tenant_id, store_id). */
    public function row(string $storeId): FraudGuardSetting
    {
        $row = FraudGuardSetting::query()->where('store_id', $storeId)->first();
        if ($row === null) {
            $now = now();
            DB::table('fraud_guard_settings')->insertOrIgnore(self::defaults() + [
                'id' => strtolower((string) Str::ulid()),
                'tenant_id' => $this->context->id(),
                'store_id' => $storeId,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
            $row = FraudGuardSetting::query()->where('store_id', $storeId)->firstOrFail();
        }

        return $this->memo[$storeId] = $row;
    }

    /** @return array{hold_below: int, advance_below: int, min_parcels: int} */
    public function thresholds(string $storeId): array
    {
        $s = $this->for($storeId);

        return ['hold_below' => (int) $s->hold_below, 'advance_below' => (int) $s->advance_below, 'min_parcels' => (int) $s->min_parcels];
    }

    public function planAllows(): bool
    {
        $tenant = $this->context->tenant();

        return $tenant !== null && FeatureGate::allows($tenant, Feature::FakeOrderGuard);
    }

    /** P88-15 + §4: plan feature and the store's switch. */
    public function guarded(string $storeId): bool
    {
        return $this->for($storeId)->enabled && $this->planAllows();
    }

    public function rulesOn(string $storeId): int
    {
        $s = $this->for($storeId);

        return count(array_filter(self::RULES, fn (string $rule) => (bool) $s->{$rule}));
    }

    /** @param array<string, mixed> $input validated keys only */
    public function update(string $storeId, array $input, ?User $user): FraudGuardSetting
    {
        return DB::transaction(function () use ($storeId, $input, $user) {
            $row = FraudGuardSetting::query()->whereKey($this->row($storeId)->id)->lockForUpdate()->firstOrFail();
            foreach ($input as $key => $value) {
                if (in_array($key, FraudGuardSetting::BOOLEANS, true)) {
                    $row->{$key} = (bool) $value;
                } elseif (in_array($key, FraudGuardSetting::INTEGERS, true)) {
                    $row->{$key} = (int) $value;
                }
            }
            $row->updated_by = $user?->getKey();
            $row->save();
            $this->memo[$storeId] = $row;

            return $row;
        });
    }

    public function forget(string $storeId): void
    {
        unset($this->memo[$storeId]);
    }
}
