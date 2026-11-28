<?php

declare(strict_types=1);

namespace App\Domain\Support\Console;

use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\SupportTicketService;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/** PHASE-8-9C P89C-16: hourly, tickets resolved ≥ 7 days ago are closed (`auto_closed` system row, no mail). */
class CloseResolvedTickets extends Command
{
    protected $signature = 'support:close-resolved';

    protected $description = 'Close support tickets resolved more than 7 days ago';

    public function handle(TenantContext $context, SupportTicketService $tickets): int
    {
        $closed = 0;
        SupportTicket::withoutTenancy()->where('status', SupportTicket::RESOLVED)
            ->where('resolved_at', '<=', now()->subDays(SupportTicket::AUTO_CLOSE_DAYS))
            ->orderBy('id')->get(['id', 'tenant_id'])
            ->each(function (SupportTicket $t) use ($context, $tickets, &$closed) {
                if ($context->run($t->tenant_id, fn () => $tickets->autoClose($t->id))) {
                    $closed++;
                }
            });
        $this->info("closed={$closed}");

        return self::SUCCESS;
    }
}
