<?php

declare(strict_types=1);

namespace App\Domain\Integrations;

use App\Domain\Integrations\Mail\IntegrationAlertMail;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;

/**
 * PHASE-8-9D §4.4: attention reasons and the status they imply. `token_invalid` / `token_expired` → `error`; any other
 * reason → `needs_attention`; none → `connected`. `setup_required` and `disconnected` rows keep their status. A
 * transition into `error` emails the owner and admins once (P89D-16: "Your {Meta} access token stopped working").
 * Writes are compare-free single-row updates (no revision bump: attention is system state, not merchant settings).
 */
final class IntegrationAttention
{
    public const ERROR_REASONS = ['token_invalid', 'token_expired'];

    public const REASONS = ['token_invalid', 'token_expiring', 'token_expired', 'setup_incomplete', 'website_not_claimed', 'store_not_live',
        'items_with_issues', 'plan_required', 'endpoint_unreachable', 'delivery_failing'];

    /**
     * Adds / refreshes ($set reason => count|null) and removes reasons, recomputes the status, saves, and mails on a
     * transition into `error`. Returns the row.
     *
     * @param  array<string, int|null>  $set
     * @param  list<string>  $remove
     */
    public static function apply(StoreIntegration $row, array $set = [], array $remove = []): StoreIntegration
    {
        $current = [];
        foreach ($row->attention ?? [] as $a) {
            $current[(string) $a['reason']] = $a;
        }
        foreach ($remove as $reason) {
            unset($current[$reason]);
        }
        foreach ($set as $reason => $count) {
            $current[$reason] = ['reason' => $reason, 'count' => $count, 'since' => $current[$reason]['since'] ?? now()->toIso8601ZuluString()];
        }
        $attention = array_values(array_filter(array_map(fn (string $r) => $current[$r] ?? null, self::REASONS)));
        $before = $row->status;
        $status = self::status($before, $attention);
        if ($attention === ($row->attention ?? []) && $status === $before) {
            return $row;
        }
        $row->attention = $attention;
        $row->status = $status;
        $row->save();
        if ($status === StoreIntegration::ERROR && $before !== StoreIntegration::ERROR) {
            $reason = array_values(array_intersect(self::ERROR_REASONS, array_map(fn (array $a) => $a['reason'], $attention)))[0] ?? 'token_invalid';
            self::mail($row, $reason);
        }

        return $row;
    }

    /** @param list<array{reason: string}> $attention */
    public static function status(string $current, array $attention): string
    {
        if (in_array($current, [StoreIntegration::SETUP_REQUIRED, StoreIntegration::DISCONNECTED], true)) {
            return $current;
        }
        $reasons = array_map(fn (array $a) => $a['reason'], $attention);

        return match (true) {
            array_intersect($reasons, self::ERROR_REASONS) !== [] => StoreIntegration::ERROR,
            $reasons !== [] => StoreIntegration::NEEDS_ATTENTION,
            default => StoreIntegration::CONNECTED,
        };
    }

    /** Owner + admins of the tenant, after commit, queued (plain values only). */
    private static function mail(StoreIntegration $row, string $reason): void
    {
        $tenantId = $row->tenant_id;
        $provider = $row->provider;
        $shop = (string) Store::query()->whereKey($row->store_id)->value('name');
        DB::afterCommit(function () use ($tenantId, $provider, $shop, $reason) {
            $emails = TenantUser::query()->where('tenant_id', $tenantId)
                ->whereIn('role', [TenantUser::ROLE_OWNER, TenantUser::ROLE_ADMIN])
                ->join('users', 'users.id', '=', 'tenant_users.user_id')->pluck('users.email')->filter()->unique()->values()->all();
            foreach ($emails as $email) {
                Mail::to($email)->queue(new IntegrationAlertMail($provider, $reason, $shop));
            }
        });
    }
}
