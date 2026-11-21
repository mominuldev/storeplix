<?php

namespace App\Domain\Tenancy\Support;

use App\Domain\Billing\Models\Subscription;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * Writes the append-only audit trail. Callers pass ONLY redacted meta
 * (changed key names, role from/to) — never passwords, tokens or contact values.
 */
class AuditLogger
{
    /** Model class → public subject_type (AuditLog.subject.type / filter[subject_type]). */
    public const SUBJECT_TYPES = [
        Store::class => 'store',
        StoreSetting::class => 'store_settings',
        TenantUser::class => 'staff_member',
        StaffInvitation::class => 'staff_invitation',
        Media::class => 'media',
        Subscription::class => 'subscription',
        User::class => 'user',
        Tenant::class => 'tenant',
        StoreTheme::class => 'store_theme',
        StorePage::class => 'store_page',
        StoreNavigation::class => 'store_navigation',
    ];

    public function __construct(
        private readonly TenantContext $context,
        private readonly ?Request $request = null,
    ) {}

    /**
     * @param  array<string, mixed>  $meta
     * @param  bool  $system  true for scheduler/queue actions with no human actor
     * @param  string|false|null  $tenantId  null = current context; false = force account-level (tenant_id null)
     */
    public function log(
        string $action,
        ?Model $subject = null,
        array $meta = [],
        ?Authenticatable $actor = null,
        string|false|null $tenantId = null,
        bool $system = false,
    ): AuditLog {
        if (! $system) {
            $actor ??= $this->request?->user();
        }

        return AuditLog::query()->create([
            'tenant_id' => $tenantId === false ? null : ($tenantId ?? $this->context->id()),
            'actor_type' => $actor ? 'user' : 'system',
            'actor_id' => $actor?->getAuthIdentifier(),
            'action' => $action,
            'subject_type' => $subject ? (self::SUBJECT_TYPES[$subject::class] ?? Str::snake(class_basename($subject))) : null,
            'subject_id' => $subject?->getKey(),
            'ip' => $system ? null : $this->request?->ip(),
            'user_agent' => $system ? null : (Str::limit((string) $this->request?->userAgent(), 252, '...') ?: null),
            'meta' => $meta ?: null,
        ]);
    }
}
