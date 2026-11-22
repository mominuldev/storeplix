<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Couriers\Drivers\CourierDriver;
use App\Domain\Couriers\Drivers\FakeCourier;
use App\Domain\Couriers\Drivers\PathaoCourier;
use App\Domain\Couriers\Drivers\RedxCourier;
use App\Domain\Couriers\Drivers\SteadfastCourier;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Contracts\Container\Container;
use InvalidArgumentException;

/** Resolves the courier driver of a provider: FakeCourier (acting as that provider) when `couriers.fake` (§15). */
final class CourierManager
{
    public function __construct(private readonly Container $container) {}

    public function driver(string $provider): CourierDriver
    {
        if (! in_array($provider, CourierAccount::PROVIDERS, true)) {
            throw new InvalidArgumentException("Unknown courier [{$provider}].");
        }
        if ((bool) config('couriers.fake')) {
            return new FakeCourier($provider, $this->container->make(TenantCache::class));
        }

        return $this->container->make(match ($provider) {
            CourierAccount::STEADFAST => SteadfastCourier::class,
            CourierAccount::PATHAO => PathaoCourier::class,
            CourierAccount::REDX => RedxCourier::class,
        });
    }

    /** FakeCourier for status advances (couriers:fake-advance, the testing endpoint). Null unless `couriers.fake`. */
    public function fake(string $provider): ?FakeCourier
    {
        $driver = $this->driver($provider);

        return $driver instanceof FakeCourier ? $driver : null;
    }
}
