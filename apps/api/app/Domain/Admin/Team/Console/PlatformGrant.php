<?php

declare(strict_types=1);

namespace App\Domain\Admin\Team\Console;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Admin\Team\TeamManager;
use App\Domain\Identity\Models\User;
use Illuminate\Console\Command;

/** PHASE-8-1 P8-3 / §4.4 break glass: makes an existing user platform staff (creates nothing). Audit actor: system. */
class PlatformGrant extends Command
{
    use PlatformCommand;

    protected $signature = 'platform:grant {email} {role : super_admin|billing|support|read_only} {--reason= : Why (5–500 chars, stored in the audit log)} {--force : Required in production}';

    protected $description = 'Grant a platform staff role to an existing user (break glass)';

    public function handle(TeamManager $team): int
    {
        $role = PlatformRole::tryFrom((string) $this->argument('role'));
        if ($role === null) {
            $this->error('Unknown role. Use one of: '.implode(', ', array_map(fn (PlatformRole $r) => $r->value, PlatformRole::cases())).'.');

            return self::FAILURE;
        }
        if (($user = $this->user()) === null || ($reason = $this->reason()) === null || ! $this->confirmProduction()) {
            return self::FAILURE;
        }

        $team->grant($user, $role, $reason);
        $this->info("{$user->email} is now {$role->value}.".($user->totp_confirmed_at === null ? ' They enrol TOTP on their first admin sign-in.' : ''));

        return self::SUCCESS;
    }
}
