<?php

declare(strict_types=1);

namespace App\Domain\Admin\Suspension\Mail;

use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Address;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Mail;

/**
 * PHASE-8-1 Q102: owner e-mails for staff actions when the dialog's "Notify" is checked: shop suspended, shop
 * reactivated, plan changed by Store Plix. Never names the staff member; the suspension reason text stays internal.
 */
class AdminNoticeMail extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public const SUSPENDED = 'suspended';

    public const REACTIVATED = 'reactivated';

    public const PLAN_CHANGED = 'plan_changed';

    /** @param array<string, string> $data */
    public function __construct(
        public readonly string $kind,
        public readonly string $shop,
        public readonly array $data = [],
    ) {
        $this->onQueue('notifications');
    }

    /**
     * Queues the notice to the tenant's owner (no-op without one).
     *
     * @param  array<string, string>  $data
     */
    public static function sendToOwner(string $tenantId, string $kind, array $data = []): void
    {
        $db = PlatformDb::connection(); // cross-tenant: admin owner notice
        $owner = $db->table('tenant_users as tu')->join('users as u', 'u.id', '=', 'tu.user_id')
            ->where('tu.tenant_id', $tenantId)->where('tu.role', TenantUser::ROLE_OWNER)->value('u.email');
        if (! is_string($owner) || $owner === '') {
            return;
        }
        $shop = (string) ($db->table('stores')->where('tenant_id', $tenantId)->value('name')
            ?? $db->table('tenants')->where('id', $tenantId)->value('name') ?? 'Your shop');
        Mail::to($owner)->send(new self($kind, $shop, $data));
    }

    public function envelope(): Envelope
    {
        $subject = match ($this->kind) {
            self::SUSPENDED => "{$this->shop} is suspended",
            self::REACTIVATED => "{$this->shop} is active again",
            default => 'Your plan changed to '.($this->data['plan'] ?? 'a new plan'),
        };

        return new Envelope(from: new Address('support@'.config('storeplix.platform_domain'), 'Store Plix'), subject: $subject, tags: ['admin']);
    }

    public function content(): Content
    {
        return new Content(view: 'mail.admin.notice', with: [
            'kind' => $this->kind,
            'shop' => $this->shop,
            'data' => $this->data,
            'url' => rtrim((string) config('storeplix.merchant_app_url'), '/').'/',
        ]);
    }
}
