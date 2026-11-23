<?php

declare(strict_types=1);

namespace App\Domain\Admin\Impersonation\Console;

use App\Domain\Admin\Impersonation\ImpersonationService;
use Illuminate\Console\Command;

/**
 * PHASE-8-1 §4.4 (every 5 min): `active` impersonations past `expires_at` → `ended` (`ended_by: expiry`) with the
 * tenant audit row; `pending` tickets past `ticket_expires_at` → `expired` (silent).
 */
class CloseImpersonations extends Command
{
    protected $signature = 'admin:close-impersonations';

    protected $description = 'End expired impersonation sessions and expire unused tickets';

    public function handle(ImpersonationService $service): int
    {
        $result = $service->expire();
        $this->info(sprintf('Ended %d impersonation(s), expired %d ticket(s).', $result['ended'], $result['expired']));

        return self::SUCCESS;
    }
}
