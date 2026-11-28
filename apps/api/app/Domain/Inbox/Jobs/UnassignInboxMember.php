<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Jobs;

use App\Domain\Inbox\ConversationService;
use App\Domain\Inbox\InboxMembers;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Support\InboxVersion;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-8E P88E-4 (S245): a member who left or lost `inbox.manage` is unassigned from every conversation of the
 * tenant (system row `unassigned`). Dispatched after membership / role changes; checks every current assignee, so a
 * custom role edit that drops the key is covered too.
 */
class UnassignInboxMember implements ShouldQueue
{
    use Queueable, TenantAware;

    public function __construct(public readonly ?string $userId = null) {}

    public function handle(InboxMembers $members, ConversationService $conversations, InboxVersion $version): void
    {
        $assignees = InboxConversation::query()->whereNotNull('assignee_id')
            ->when($this->userId !== null, fn ($q) => $q->where('assignee_id', $this->userId))
            ->distinct()->pluck('assignee_id')->all();
        foreach ($assignees as $userId) {
            if ($members->holds((string) $userId)) {
                continue;
            }
            InboxConversation::query()->where('assignee_id', $userId)->pluck('id')->each(function (string $id) use ($conversations, $userId, $version) {
                DB::transaction(function () use ($conversations, $id, $userId, $version) {
                    $c = $conversations->lock($id);
                    if ($c->assignee_id !== $userId) {
                        return;
                    }
                    $c->forceFill(['assignee_id' => null, 'revision' => $c->revision + 1])->save();
                    $conversations->system($c, 'unassigned', ['assignee' => null], null);
                    $version->bump($c->store_id);
                });
            });
        }
    }
}
