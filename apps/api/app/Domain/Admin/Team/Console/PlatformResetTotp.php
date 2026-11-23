<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Console;

use App\Domain\Admin\Team\TeamManager;
use Illuminate\Console\Command;

/** PHASE-8-1 §4.4 break glass: clears a staff member's TOTP and recovery codes (enrolment on next sign-in). */
class PlatformResetTotp extends Command
{
    use PlatformCommand;

    protected $signature = 'platform:reset-2fa {email} {--reason= : Why (5–500 chars, stored in the audit log)} {--force : Required in production}';

    protected $description = 'Reset a platform staff member\'s two-factor authentication (break glass)';

    public function handle(TeamManager $team): int
    {
        if (($user = $this->user()) === null || ($reason = $this->reason()) === null || ! $this->confirmProduction()) {
            return self::FAILURE;
        }
        if ($user->platform_role === null) {
            $this->error("{$user->email} is not platform staff.");

            return self::FAILURE;
        }

        $team->resetTotp(null, $user, $reason);
        $this->info("Two-factor authentication reset for {$user->email}. They enrol again on their next admin sign-in.");

        return self::SUCCESS;
    }
}
