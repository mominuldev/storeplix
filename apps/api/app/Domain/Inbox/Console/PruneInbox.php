<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Console;

use App\Domain\Inbox\InboxAttachments;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMagicLink;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxWidgetSession;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * `inbox:prune` (nightly, PHASE-8-8E P88E-18, S247): conversations whose last message is older than 24 months (with
 * messages, attachments, reads, links), expired chat sessions (pending 24 h, verified 90 days after last use) and magic
 * links, and uploads never attached after 24 h. Discovery on the platform connection; every delete inside the row's own
 * tenant; storage objects after commit.
 */
class PruneInbox extends Command
{
    protected $signature = 'inbox:prune';

    protected $description = 'Delete old Inbox conversations, expired chat sessions and links, and unattached uploads';

    public function handle(TenantContext $context, InboxAttachments $attachments): int
    {
        $counts = ['conversations' => 0, 'sessions' => 0, 'links' => 0, 'uploads' => 0];
        $cutoff = now()->subMonths((int) config('inbox.retention_months', 24));

        // cross-tenant: scheduled retention job (platform connection); each delete runs inside the row's own tenant.
        InboxConversation::withoutTenancy()->where('last_message_at', '<', $cutoff)->select(['id', 'tenant_id'])->lazyById(200)
            ->each(function (InboxConversation $candidate) use ($context, $attachments, $cutoff, &$counts) {
                $context->run($candidate->tenant_id, function () use ($candidate, $attachments, $cutoff, &$counts) {
                    DB::transaction(function () use ($candidate, $attachments, $cutoff, &$counts) {
                        $c = InboxConversation::query()->whereKey($candidate->id)->where('last_message_at', '<', $cutoff)->lockForUpdate()->first();
                        if ($c === null) {
                            return;
                        }
                        $messageIds = InboxMessage::query()->where('conversation_id', $c->id)->pluck('id')->all();
                        $attachments->remove(InboxAttachment::query()->whereIn('message_id', $messageIds)->get());
                        InboxConversation::query()->whereKey($c->id)->delete();
                        $counts['conversations']++;
                    });
                });
            });

        // cross-tenant: scheduled retention job — expired sessions and links (no storage objects).
        foreach ([InboxWidgetSession::class => 'sessions', InboxMagicLink::class => 'links'] as $model => $key) {
            $model::withoutTenancy()->where('expires_at', '<', now())->select(['id', 'tenant_id'])->lazyById(500)
                ->groupBy('tenant_id')->each(function ($rows, $tenantId) use ($context, $model, $key, &$counts) {
                    $context->run((string) $tenantId, function () use ($rows, $model, $key, &$counts) {
                        $counts[$key] += $model::query()->whereIn('id', $rows->pluck('id')->all())->where('expires_at', '<', now())->delete();
                    });
                });
        }

        // cross-tenant: scheduled retention job — uploads never attached to a message or saved reply.
        InboxAttachment::withoutTenancy()->whereNull('message_id')->whereNull('saved_reply_id')->where('created_at', '<', now()->subDay())
            ->select(['id', 'tenant_id'])->lazyById(200)
            ->each(function (InboxAttachment $candidate) use ($context, $attachments, &$counts) {
                $context->run($candidate->tenant_id, function () use ($candidate, $attachments, &$counts) {
                    DB::transaction(function () use ($candidate, $attachments, &$counts) {
                        $row = InboxAttachment::query()->whereKey($candidate->id)->whereNull('message_id')->whereNull('saved_reply_id')->lockForUpdate()->first();
                        if ($row !== null) {
                            $attachments->remove([$row]);
                            $counts['uploads']++;
                        }
                    });
                });
            });

        $this->info(sprintf('inbox:prune: %d conversations, %d sessions, %d links, %d uploads deleted.', ...array_values($counts)));

        return self::SUCCESS;
    }
}
