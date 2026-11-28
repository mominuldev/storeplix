<?php

declare(strict_types=1);

namespace App\Domain\Support;

use App\Domain\Admin\Authorization\PlatformPermission;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Staff\Roles\RolePermissions;
use App\Domain\Stores\Models\Store;
use App\Domain\Support\Jobs\SendCoalescedSupportReply;
use App\Domain\Support\Mail\SupportMail;
use App\Domain\Support\Mail\SupportTicketAssignedMail;
use App\Domain\Support\Mail\SupportTicketReceivedMail;
use App\Domain\Support\Mail\SupportTicketRepliedMail;
use App\Domain\Support\Mail\SupportTicketResolvedMail;
use App\Domain\Support\Mail\SupportTicketStaffMail;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Mail;

/**
 * Support mails (PHASE-8-9C §10, P89C-21, S260). Called after commit inside the ticket's tenant context. Merchant
 * recipients never leave the tenant: the requester while they still hold `support.manage`, else the tenant owner.
 * Staff recipients: the active assignee holding `manage_support`, else `SUPPORT_TEAM_EMAIL` (unset = none). Bodies
 * are previews of merchant / staff replies only — never notes, attachments or order data.
 */
final class SupportNotifier
{
    public const PREVIEW = 300;

    public function received(SupportTicket $ticket, string $description): void
    {
        $to = $this->requester($ticket);
        if ($to !== null) {
            Mail::to($to->email)->queue(new SupportTicketReceivedMail(...$this->merchantArgs($ticket, $description)));
        }
        $this->staff($ticket, SupportTicketStaffMail::CREATED, $description);
    }

    public function staff(SupportTicket $ticket, string $event, string $preview): void
    {
        $to = $this->staffAddress($ticket);
        if ($to !== null) {
            Mail::to($to)->queue(new SupportTicketStaffMail($ticket->reference(), $ticket->subject, $this->shop(), self::preview($preview),
                self::adminUrl($ticket), $event));
        }
    }

    /** A staff reply: the first in a window is sent now, later ones are summed into one delayed mail (§10 coalescing). */
    public function replied(SupportTicket $ticket, string $body): void
    {
        $to = $this->requester($ticket);
        if ($to === null) {
            return;
        }
        $window = max(1, (int) config('support.reply_mail_window_seconds', 300));
        $args = $this->merchantArgs($ticket, $body);
        if (Cache::add('support:reply-mail:'.$ticket->id, 1, $window)) {
            Mail::to($to->email)->queue(new SupportTicketRepliedMail(...$args));

            return;
        }
        $pendingKey = 'support:reply-mail-pending:'.$ticket->id;
        $pending = (array) Cache::get($pendingKey, ['count' => 0]);
        Cache::put($pendingKey, ['count' => (int) ($pending['count'] ?? 0) + 1, 'to' => $to->email, 'args' => $args], $window * 3);
        if (Cache::add('support:reply-mail-job:'.$ticket->id, 1, $window)) {
            SendCoalescedSupportReply::dispatch($ticket->id)->delay(now()->addSeconds($window));
        }
    }

    public function resolved(SupportTicket $ticket): void
    {
        $to = $this->requester($ticket);
        if ($to !== null) {
            Mail::to($to->email)->queue(new SupportTicketResolvedMail(...$this->merchantArgs($ticket, '')));
        }
    }

    public function assigned(SupportTicket $ticket, User $assignee, User $actor): void
    {
        if ($assignee->id === $actor->id || ! self::activeSupportStaff($assignee)) {
            return;
        }
        Mail::to($assignee->email)->queue(new SupportTicketAssignedMail($ticket->reference(), $ticket->subject, $this->shop(), '',
            self::adminUrl($ticket), self::firstName((string) $actor->name)));
    }

    /** The requester while still a member holding `support.manage`, else the tenant owner (never outside the tenant). */
    public function requester(SupportTicket $ticket): ?User
    {
        if ($ticket->requester_id !== null) {
            $membership = TenantUser::query()->where('tenant_id', $ticket->tenant_id)->where('user_id', $ticket->requester_id)->first(['role_id']);
            $role = $membership?->role_id === null ? null : Role::query()->whereKey($membership->role_id)->first();
            if ($role !== null && RolePermissions::for($role)->has(Permission::SupportManage)) {
                return User::query()->find($ticket->requester_id);
            }
        }
        $owner = TenantUser::query()->where('tenant_id', $ticket->tenant_id)->where('role', TenantUser::ROLE_OWNER)->value('user_id');

        return $owner === null ? null : User::query()->find($owner);
    }

    private function staffAddress(SupportTicket $ticket): ?string
    {
        if ($ticket->assignee_id !== null) {
            $assignee = User::query()->find($ticket->assignee_id);
            if ($assignee instanceof User && self::activeSupportStaff($assignee)) {
                return $assignee->email;
            }
        }
        $team = config('support.team_email');

        return is_string($team) && trim($team) !== '' ? trim($team) : null;
    }

    public static function activeSupportStaff(User $user): bool
    {
        $role = $user->platform_role === null ? null : PlatformRole::tryFrom((string) $user->platform_role);

        return $role !== null && $role->can(PlatformPermission::ManageSupport) && $user->platform_disabled_at === null;
    }

    /** @return array{0: string, 1: string, 2: string, 3: string, 4: string} */
    private function merchantArgs(SupportTicket $ticket, string $preview): array
    {
        return [$ticket->reference(), $ticket->subject, $this->shop(), self::preview($preview),
            rtrim((string) config('storeplix.merchant_app_url'), '/').'/help/tickets/'.$ticket->id];
    }

    private function shop(): string
    {
        return (string) (Store::query()->value('name') ?? 'Your shop');
    }

    public static function adminUrl(SupportTicket $ticket): string
    {
        return rtrim((string) config('admin.app_url'), '/').'/support/'.$ticket->id;
    }

    public static function preview(string $text): string
    {
        $text = trim((string) preg_replace('/\s+/u', ' ', $text));

        return mb_strlen($text) > self::PREVIEW ? rtrim(mb_substr($text, 0, self::PREVIEW - 1)).'…' : $text;
    }

    public static function firstName(string $name): string
    {
        $parts = preg_split('/\s+/u', trim($name)) ?: [];

        return (string) ($parts[0] ?? '') !== '' ? (string) $parts[0] : 'Store Plix';
    }

    /** @param array{0: string, 1: string, 2: string, 3: string, 4: string} $args */
    public static function coalesced(string $to, array $args, int $count): SupportMail
    {
        return new SupportTicketRepliedMail($args[0], $args[1], $args[2], $args[3], $args[4], '', $count);
    }
}
