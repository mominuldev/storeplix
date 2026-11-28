<?php

declare(strict_types=1);

namespace App\Domain\Support\Admin;

use App\Domain\Identity\Models\User;
use App\Domain\Support\SupportNotifier;
use App\Domain\Support\SupportTicketService;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * PHASE-8-9C P89C-18: a staff member who is disabled or loses `manage_support` is unassigned from every not-closed
 * ticket (an `unassigned` system row each). Platform job: finds the tenants on the admin connection, then writes inside
 * each tenant (`// cross-tenant: support staff unassignment`).
 */
class UnassignSupportStaff implements ShouldQueue
{
    use Queueable;

    public function __construct(public readonly string $userId) {}

    public function handle(TenantContext $context, SupportTicketService $tickets): void
    {
        $user = User::query()->find($this->userId);
        if ($user instanceof User && SupportNotifier::activeSupportStaff($user)) {
            return; // still eligible (e.g. re-enabled before the job ran)
        }
        $tenants = SupportQueue::query()->where('assignee_id', $this->userId)->where('status', '<>', 'closed') // cross-tenant: support staff unassignment
            ->distinct()->pluck('tenant_id')->all();
        foreach ($tenants as $tenantId) {
            $context->run((string) $tenantId, fn () => $tickets->unassignStaff($this->userId));
        }
    }
}
