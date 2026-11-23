<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Mail\BillingMail;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

/** P7-21: owner-only billing emails (Q88) and ops alerts. Call inside the tenant context. */
final class BillingNotifier
{
    /** @param array<string, string|int|null> $data */
    public function owner(string $kind, array $data = []): void
    {
        $owner = self::ownerUser();
        if ($owner === null || $owner->email === null) {
            Log::info('billing.mail_skipped', ['kind' => $kind]);

            return;
        }
        Mail::to($owner->email)->send(new BillingMail($kind, self::shopName(), $data));
    }

    /** @param array<string, string|int|null> $data */
    public function ops(string $event, array $data = []): void
    {
        Log::warning('billing.ops_alert', ['event' => $event] + array_intersect_key($data, array_flip(['tenant', 'number', 'payment'])));
        $to = config('billing.ops_email');
        if (is_string($to) && $to !== '') {
            Mail::to($to)->send(new BillingMail(BillingMail::OPS_ALERT, self::shopName(), ['event' => $event] + $data));
        }
    }

    public static function ownerUser(): ?User
    {
        $tenantId = app(TenantContext::class)->requireId();
        $ownerId = TenantUser::query()->where('tenant_id', $tenantId)->where('role', TenantUser::ROLE_OWNER)->value('user_id');

        return $ownerId !== null ? User::query()->find($ownerId) : null;
    }

    public static function shopName(): string
    {
        return (string) (Store::query()->value('name') ?? Tenant::query()->whereKey(app(TenantContext::class)->id())->value('name') ?? 'Your shop');
    }

    /** Marks a once-only notice on the subscription (subscriptions.notices). Returns false when it was already sent. */
    public static function claimNotice(Models\Subscription $subscription, string $key): bool
    {
        $notices = DB::table('subscriptions')->where('id', $subscription->id)->lockForUpdate()->value('notices');
        $notices = is_string($notices) ? (json_decode($notices, true) ?: []) : (array) $notices;
        if (isset($notices[$key])) {
            return false;
        }
        $notices[$key] = now()->toIso8601ZuluString();
        DB::table('subscriptions')->where('id', $subscription->id)->update(['notices' => json_encode($notices)]);
        $subscription->notices = $notices;

        return true;
    }

    public static function date(?Carbon $at): string
    {
        $tz = (string) (Store::query()->value('timezone') ?: 'Asia/Dhaka');

        return $at === null ? '—' : $at->copy()->timezone($tz)->format('j M Y');
    }
}
