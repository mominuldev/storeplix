<?php

declare(strict_types=1);

namespace App\Domain\Developer\External;

use App\Domain\Developer\ApiKeys\CurrentApiKey;
use App\Domain\Identity\Models\User;
use Illuminate\Contracts\Auth\Access\Gate;
use Illuminate\Contracts\Auth\Authenticatable;

/**
 * PHASE-8-4 P84-4: the external controllers reuse the merchant controllers, whose policy checks
 * (`Gate::authorize('view', $store)` …) need a user. Tenant policies decide from the TenantContext only (tenant of the
 * model + the resolved PermissionSet), never from the user. While an API key acts (CurrentApiKey set, no user
 * signed in) this `before` callback evaluates the SAME policy method with a transient, unsaved User and the key's
 * PermissionSet in the context. Without a policy for the subject, or outside the external API, it does nothing / denies.
 */
final class ExternalGate
{
    public static function register(Gate $gate): void
    {
        $gate->before(function (?Authenticatable $user, string $ability, array $arguments) use ($gate): ?bool {
            if ($user !== null || CurrentApiKey::current() === null) {
                return null;
            }
            $subject = $arguments[0] ?? null;
            $policy = $subject === null ? null : $gate->getPolicyFor($subject);
            if ($policy === null || ! method_exists($policy, $ability)) {
                return false;
            }

            return (bool) $policy->{$ability}(new User, ...$arguments);
        });
    }
}
