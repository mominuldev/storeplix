<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Inbox\Console\PruneInbox;
use App\Domain\Inbox\Jobs\UnassignInboxMember;
use App\Domain\Inbox\Support\OrderAccessToken;
use App\Domain\Shared\Support\Phone;
use App\Domain\Staff\Roles\Models\Role;
use App\Domain\Stores\Services\StorefrontContext;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.8e Inbox: the `inbox:prune` command (schedule in routes/console.php), the limiters (PHASE-8-8E P88E-13, §7,
 * §13) and the staff hooks that unassign a member who left or lost `inbox.manage` (P88E-4). Registered from
 * AppServiceProvider.
 */
final class InboxServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([PruneInbox::class]);
        }

        $member = fn (string $name, Request $r) => $name.':'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.strtolower((string) $r->header('X-Tenant-Id'));
        RateLimiter::for('inbox-write', fn (Request $r) => Limit::perMinute(120)->by($member('inbox-write', $r)));
        RateLimiter::for('inbox-upload', fn (Request $r) => Limit::perMinute(30)->by($member('inbox-upload', $r)));

        $host = fn (Request $r) => strtolower((string) $r->header('X-Storefront-Host'));
        $ip = fn (Request $r) => StorefrontContext::ipKey(StorefrontContext::clientIp($r));
        RateLimiter::for('inbox-widget-start', function (Request $r) use ($host, $ip) {
            $limits = [Limit::perHour(5)->by('inbox-widget-start-ip:'.$host($r).'|'.$ip($r))];
            $phone = Phone::bdMsisdn(is_string($r->input('phone')) ? $r->input('phone') : null);
            if ($phone !== null) {
                $limits[] = Limit::perHour(3)->by('inbox-widget-start-phone:'.$host($r).'|'.$phone);
            }

            return $limits;
        });
        RateLimiter::for('inbox-widget-code', fn (Request $r) => Limit::perHour((int) config('inbox.code_sends_per_ip_per_hour', 20))
            ->by('inbox-widget-code-ip:'.$host($r).'|'.$ip($r)));
        RateLimiter::for('inbox-widget-message', function (Request $r) use ($host) {
            $order = OrderAccessToken::peekOrderId($r->header('X-Order-Access'));
            $key = $order !== null ? 'order:'.$order : 'session:'.hash('sha256', (string) $r->header('X-Inbox-Session', $r->ip()));

            return [
                Limit::perMinute(20)->by('inbox-widget-message-min:'.$host($r).'|'.$key),
                Limit::perDay(200)->by('inbox-widget-message-day:'.$host($r).'|'.$key),
            ];
        });
        RateLimiter::for('inbox-link', fn (Request $r) => Limit::perMinute(20)->by('inbox-link:'.$ip($r)));

        // P88E-4: a member who leaves or changes role (or whose custom role is edited) is unassigned when they no longer
        // hold inbox.manage. After commit, inside the membership's tenant.
        TenantUser::deleted(fn (TenantUser $m) => self::sweep($m->tenant_id, $m->user_id));
        TenantUser::updated(function (TenantUser $m) {
            if ($m->wasChanged(['role_id', 'role'])) {
                self::sweep($m->tenant_id, $m->user_id);
            }
        });
        Role::updated(function (Role $role) {
            if ($role->wasChanged('revision')) {
                self::sweep($role->tenant_id, null);
            }
        });
    }

    private static function sweep(string $tenantId, ?string $userId): void
    {
        UnassignInboxMember::dispatch($userId)->forTenant($tenantId)->afterCommit();
    }
}
