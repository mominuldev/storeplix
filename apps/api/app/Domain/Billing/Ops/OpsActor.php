<?php

declare(strict_types=1);

namespace App\Domain\Billing\Ops;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\Eloquent\Model;

/**
 * PHASE-8-1 P8-7 / P8-8: who runs an ops Action. `staff = null` is the ops command (audit `actor_type: system`, as in
 * Phase 6/7); a staff user is the admin API (audit `actor_type: platform_user` + `meta.platform_role`). `reason` lands
 * in `meta.reason` of the Action's audit row; the row always carries the target tenant id.
 */
final readonly class OpsActor
{
    public function __construct(
        public ?User $staff,
        public string $reason,
    ) {}

    public static function system(string $reason): self
    {
        return new self(null, $reason);
    }

    public static function staff(User $staff, string $reason): self
    {
        return new self($staff, $reason);
    }

    public function isStaff(): bool
    {
        return $this->staff !== null;
    }

    /** @param array<string, mixed> $meta */
    public function audit(string $action, ?Model $subject, array $meta, ?string $tenantId = null): AuditLog
    {
        return app(AuditLogger::class)->log(
            $action, $subject, $meta,
            actor: $this->staff,
            tenantId: $tenantId,
            system: $this->staff === null,
            platform: $this->staff !== null ? true : null,
        );
    }
}
