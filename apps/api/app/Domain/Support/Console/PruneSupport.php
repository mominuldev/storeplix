<?php

declare(strict_types=1);

namespace App\Domain\Support\Console;

use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\Models\SupportTicketAttachment;
use App\Domain\Support\SupportAttachments;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-9C P89C-22 / S261 (nightly): closed tickets 24 months after `closed_at` are deleted with their messages and
 * attachments (objects after commit), and unattached uploads older than 24 h are removed. Per tenant, inside it.
 */
class PruneSupport extends Command
{
    protected $signature = 'support:prune';

    protected $description = 'Delete closed support tickets after 24 months and orphan uploads after 24 hours';

    public function handle(TenantContext $context, SupportAttachments $attachments): int
    {
        $tickets = 0;
        $orphans = 0;
        $old = SupportTicket::withoutTenancy()->where('status', SupportTicket::CLOSED)->where('closed_at', '<', now()->subMonths(24))
            ->get(['id', 'tenant_id'])->groupBy('tenant_id');
        foreach ($old as $tenantId => $rows) {
            $context->run((string) $tenantId, function () use ($rows, $attachments, &$tickets) {
                foreach ($rows as $row) {
                    DB::transaction(function () use ($row, $attachments, &$tickets) {
                        $attachments->remove(SupportTicketAttachment::query()->where('ticket_id', $row->id)->get());
                        $tickets += SupportTicket::query()->whereKey($row->id)->delete();
                    });
                }
            });
        }
        $pending = SupportTicketAttachment::withoutTenancy()->whereNull('message_id')->where('created_at', '<', now()->subDay())
            ->get(['id', 'tenant_id', 'media_id'])->groupBy('tenant_id');
        foreach ($pending as $tenantId => $rows) {
            $context->run((string) $tenantId, function () use ($rows, $attachments, &$orphans) {
                DB::transaction(fn () => $attachments->remove(SupportTicketAttachment::query()->whereIn('id', $rows->pluck('id')->all())->whereNull('message_id')->get()));
                $orphans += $rows->count();
            });
        }
        $this->info("tickets={$tickets} orphan_uploads={$orphans}");

        return self::SUCCESS;
    }
}
