<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Console;

use App\Domain\Admin\Team\TeamManager;
use Illuminate\Console\Command;

/** PHASE-8-1 P8-3 / §4.4 break glass: removes the platform role, clears TOTP, ends admin sessions and impersonations. */
class PlatformRevoke extends Command
{
    use PlatformCommand;

    protected $signature = 'platform:revoke {email} {--reason= : Why (5–500 chars, stored in the audit log)} {--force : Required in production}';

    protected $description = 'Remove a user\'s platform staff role (break glass)';

    public function handle(TeamManager $team): int
    {
        if (($user = $this->user()) === null || ($reason = $this->reason()) === null || ! $this->confirmProduction()) {
            return self::FAILURE;
        }
        if ($user->platform_role === null) {
            $this->warn("{$user->email} is not platform staff.");

            return self::SUCCESS;
        }

        $team->revoke($user, $reason);
        $this->info("{$user->email} is no longer platform staff.");

        return self::SUCCESS;
    }
}
