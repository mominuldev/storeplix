<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Casts;

use App\Domain\Integrations\IntegrationCredentials;
use Illuminate\Contracts\Database\Eloquent\CastsAttributes;
use Illuminate\Database\Eloquent\Model;
use InvalidArgumentException;

/**
 * Eloquent cast: an array of secrets stored as IntegrationCredentials ciphertext (S26). Pair it with `$hidden` so
 * the attribute never reaches toArray()/JSON. An empty array is stored as encrypted "{}" (disconnected accounts).
 *
 * @implements CastsAttributes<array<string, mixed>, array<string, mixed>>
 */
final class EncryptedCredentials implements CastsAttributes
{
    /** @return array<string, mixed>|null */
    public function get(Model $model, string $key, mixed $value, array $attributes): ?array
    {
        return $value === null ? null : app(IntegrationCredentials::class)->decrypt((string) $value);
    }

    public function set(Model $model, string $key, mixed $value, array $attributes): ?string
    {
        if ($value === null) {
            return null;
        }
        if (! is_array($value)) {
            throw new InvalidArgumentException("{$key} must be an array of credentials.");
        }

        return app(IntegrationCredentials::class)->encrypt($value);
    }
}
