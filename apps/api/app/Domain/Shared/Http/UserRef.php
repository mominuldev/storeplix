<?php

namespace App\Domain\Shared\Http;

use App\Domain\Identity\Models\User;

/** UserRef {id, name} (@storeplix/types). */
final class UserRef
{
    /** @return array{id: string, name: string}|null */
    public static function of(?User $user): ?array
    {
        return $user === null ? null : ['id' => $user->id, 'name' => (string) $user->name];
    }

    public static function iso(mixed $date): ?string
    {
        return $date?->toIso8601ZuluString();
    }
}
