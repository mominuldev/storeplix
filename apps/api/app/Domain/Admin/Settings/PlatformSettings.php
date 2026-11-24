<?php

declare(strict_types=1);

namespace App\Domain\Admin\Settings;

use App\Domain\Admin\Settings\Models\PlatformSetting;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;

/**
 * PHASE-8-1 amendment A1-2: platform settings (`platform_settings`), read through one cached map (platform-wide, so the
 * cache key is not tenant-prefixed) and busted on every write. Reads run on the default connection (the app role may
 * SELECT); writes go through the platform connection (admin API only).
 */
final class PlatformSettings
{
    public const STAFF_TWO_FACTOR_REQUIRED = 'staff_two_factor_required';

    public const CACHE_KEY = 'platform:settings:v1';

    private const CACHE_SECONDS = 300;

    /** Amendment A1-1: the value used when nothing is stored (`ADMIN_TWO_FACTOR_REQUIRED`, else off only on local). */
    public function staffTwoFactorDefault(): bool
    {
        return (bool) config('admin.two_factor_required_default', true);
    }

    /** Effective value: the stored setting, else the environment default. */
    public function staffTwoFactorRequired(): bool
    {
        $row = $this->stored(self::STAFF_TWO_FACTOR_REQUIRED);

        return is_bool($row['value'] ?? null) ? $row['value'] : $this->staffTwoFactorDefault();
    }

    /**
     * openapi `PlatformSecuritySettings`.
     *
     * @return array{staff_two_factor_required: bool, environment_default: bool, source: string, updated_at: string|null, updated_by: array{id: string, name: string}|null}
     */
    public function security(): array
    {
        $row = $this->stored(self::STAFF_TWO_FACTOR_REQUIRED);
        $stored = is_bool($row['value'] ?? null);
        $updater = $stored && $row['updated_by'] !== null ? User::query()->find($row['updated_by'], ['id', 'name']) : null;

        return [
            'staff_two_factor_required' => $this->staffTwoFactorRequired(),
            'environment_default' => $this->staffTwoFactorDefault(),
            'source' => $stored ? 'setting' : 'default',
            'updated_at' => $stored ? $row['updated_at'] : null,
            'updated_by' => $updater !== null ? ['id' => $updater->id, 'name' => $updater->name] : null,
        ];
    }

    public function set(string $key, mixed $value, ?User $by): void
    {
        PlatformDb::reroute(PlatformSetting::query())->updateOrCreate(
            ['key' => $key],
            ['value' => $value, 'updated_by' => $by?->id],
        );
        $this->flush();
    }

    public function flush(): void
    {
        Cache::forget(self::CACHE_KEY);
    }

    /** @return array{value: mixed, updated_by: string|null, updated_at: string|null}|null */
    private function stored(string $key): ?array
    {
        return $this->all()[$key] ?? null;
    }

    /** @return array<string, array{value: mixed, updated_by: string|null, updated_at: string|null}> */
    private function all(): array
    {
        /** @var array<string, array{value: mixed, updated_by: string|null, updated_at: string|null}> */
        return Cache::remember(self::CACHE_KEY, self::CACHE_SECONDS, function (): array {
            $map = [];
            foreach (PlatformSetting::query()->get() as $row) {
                $map[$row->key] = [
                    'value' => $row->value,
                    'updated_by' => $row->updated_by,
                    'updated_at' => $row->updated_at instanceof Carbon ? $row->updated_at->toIso8601ZuluString() : null,
                ];
            }

            return $map;
        });
    }
}
