<?php

declare(strict_types=1);

namespace App\Domain\Automations\Recipes;

use InvalidArgumentException;

/** The fixed catalogue (P86-2), UI order. */
final class RecipeCatalogue
{
    public const KEYS = ['checkout_recovery', 'thank_you', 'vip_tag', 'return_flag', 'low_stock'];

    /** @var array<string, Recipe> */
    private static array $recipes = [];

    public static function get(string $key): Recipe
    {
        return self::$recipes[$key] ??= match ($key) {
            'checkout_recovery' => new CheckoutRecovery,
            'thank_you' => new ThankYou,
            'vip_tag' => new VipTag,
            'return_flag' => new ReturnFlag,
            'low_stock' => new LowStock,
            default => throw new InvalidArgumentException("Unknown recipe [{$key}]."),
        };
    }

    /** @return list<Recipe> */
    public static function all(): array
    {
        return array_map(fn (string $k) => self::get($k), self::KEYS);
    }

    /** @return list<string> recipe keys listening to a trigger */
    public static function forTrigger(string $trigger): array
    {
        return array_values(array_filter(self::KEYS, fn (string $k) => self::get($k)->trigger() === $trigger));
    }
}
