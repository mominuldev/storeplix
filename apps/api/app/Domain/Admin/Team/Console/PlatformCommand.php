<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Console;

use App\Domain\Identity\Models\User;

/** Shared argument handling for the `platform:*` break-glass commands. */
trait PlatformCommand
{
    private function user(): ?User
    {
        $email = strtolower(trim((string) $this->argument('email')));
        $user = User::query()->where('email', $email)->first();
        if ($user === null) {
            $this->error("No user with the email {$email}. The user must sign up first.");
        }

        return $user;
    }

    private function reason(): ?string
    {
        $reason = trim((string) $this->option('reason'));
        $length = mb_strlen($reason);
        if ($length < 5 || $length > 500) {
            $this->error('--reason is required (5–500 characters).');

            return null;
        }

        return $reason;
    }

    private function confirmProduction(): bool
    {
        if (app()->environment('production') && ! $this->option('force')) {
            $this->error('Refusing to run in production without --force.');

            return false;
        }

        return true;
    }
}
