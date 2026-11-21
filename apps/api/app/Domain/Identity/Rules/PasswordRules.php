<?php

namespace App\Domain\Identity\Rules;

use Illuminate\Validation\Rules\Password;

/** The one password rule used everywhere (Phase 2 contract §1.1). No uncompromised() check. */
final class PasswordRules
{
    /** @return list<mixed> */
    public static function rules(): array
    {
        return ['required', 'string', 'min:8', 'max:128', 'confirmed', Password::min(8)->letters()->numbers()];
    }
}
