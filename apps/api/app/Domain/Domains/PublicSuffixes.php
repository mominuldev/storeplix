<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use Pdp\Domain;
use Pdp\Rules;
use Throwable;

/**
 * P6-4: the committed Public Suffix List snapshot (ICANN + private sections), parsed once per process.
 * `php artisan domains:update-psl` refreshes the file.
 */
final class PublicSuffixes
{
    private static ?Rules $rules = null;

    private static ?string $loadedFrom = null;

    public static function rules(): Rules
    {
        $path = (string) config('domains.psl_path');
        if (self::$rules === null || self::$loadedFrom !== $path) {
            self::$rules = Rules::fromPath($path);
            self::$loadedFrom = $path;
        }

        return self::$rules;
    }

    /**
     * The registrable domain of an ASCII host, or null when the host is itself a public suffix or its suffix is not
     * on the list (unknown TLD).
     */
    public static function registrable(string $asciiHost): ?string
    {
        try {
            $resolved = self::rules()->resolve(Domain::fromIDNA2008($asciiHost));
        } catch (Throwable) {
            return null;
        }
        if (! $resolved->suffix()->isKnown()) {
            return null;
        }

        return $resolved->registrableDomain()->value();
    }

    public static function forget(): void
    {
        self::$rules = null;
        self::$loadedFrom = null;
    }
}
