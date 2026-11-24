<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\TenantContext;

/**
 * Monthly campaign allowances (PHASE-8-5 §2.2, P85-13, P85-14). Must be called inside the tenant context.
 *
 * usage (calendar month, store timezone) = recipients `sent` / `sending` / `unknown` (SMS: Σ parts; email: count) whose
 * send happened this month (`sent_at`, else the row's last update) + test sends. Test sends have no recipient row:
 * they are counted from their `campaign.test_sent` audit rows (`meta.channel`, `meta.parts`), which every test send
 * writes (P85-26). Order SMS (`sms_per_month`, P5-26) never include campaign traffic (purpose `campaign`).
 *
 * PHASE-8-6 P86-8 (Q157): the allowance is shared with automations — automation message steps `done` / `sending` /
 * `unknown` executed this month (SMS: Σ parts; email: count) and `automation.test_sent` audit rows count too.
 */
final class CampaignAllowance
{
    public static function limitKey(string $channel): Limit
    {
        return $channel === Campaign::SMS ? Limit::CampaignSmsPerMonth : Limit::CampaignEmailsPerMonth;
    }

    public static function used(string $channel): int
    {
        $since = FeatureGate::monthStart();
        $q = CampaignRecipient::query()->where('channel', $channel)->whereIn('status', CampaignRecipient::COUNTED)
            ->where(fn ($w) => $w->where('sent_at', '>=', $since)->orWhere(fn ($x) => $x->whereNull('sent_at')->where('updated_at', '>=', $since)));
        $recipients = $channel === Campaign::SMS ? (int) $q->sum('parts') : $q->count();

        $steps = AutomationRunStep::query()->where('action', AutomationRunStep::SEND_MESSAGE)->where('channel', $channel)
            ->whereIn('status', AutomationRunStep::COUNTED)->where('executed_at', '>=', $since);
        $automations = $channel === Campaign::SMS ? (int) $steps->sum('parts') : $steps->count();

        $tests = 0;
        $rows = AuditLog::query()->where('tenant_id', app(TenantContext::class)->requireId())
            ->whereIn('action', ['campaign.test_sent', 'automation.test_sent'])->where('created_at', '>=', $since)->get(['meta']);
        foreach ($rows as $row) {
            $meta = (array) $row->meta;
            if (($meta['channel'] ?? null) === $channel) {
                $tests += $channel === Campaign::SMS ? max(1, (int) ($meta['parts'] ?? 1)) : 1;
            }
        }

        return $recipients + $automations + $tests;
    }

    /** @return array{limit: int|null, used: int, remaining: int|null, after: int|null} for `$needed` more units */
    public static function summary(Tenant $tenant, string $channel, int $needed): array
    {
        $limit = FeatureGate::limit($tenant, self::limitKey($channel));
        $used = self::used($channel);
        $remaining = $limit === null ? null : max(0, $limit - $used);

        return ['limit' => $limit, 'used' => $used, 'remaining' => $remaining, 'after' => $remaining === null ? null : $remaining - $needed];
    }

    /** 402 plan_limit_reached with `details.{key} {limit, used, needed}` (+ upgrade_plan) when $needed doesn't fit. */
    public static function assertFits(Tenant $tenant, string $channel, int $needed): void
    {
        $key = self::limitKey($channel);
        $limit = FeatureGate::limit($tenant, $key);
        if ($limit === null) {
            return;
        }
        $used = self::used($channel);
        if ($used + $needed <= $limit) {
            return;
        }
        $upgrade = FeatureGate::upgradePlanForLimit($key, $used + max(1, $needed));
        $details = [$key->value => ['limit' => $limit, 'used' => $used, 'needed' => $needed]];
        if ($upgrade !== null) {
            $details['upgrade_plan'] = [$upgrade];
        }
        $message = $limit === 0
            ? 'Campaigns are part of the Starter plan.'
            : ($channel === Campaign::SMS
                ? "Not enough campaign SMS left this month: {$needed} needed, ".max(0, $limit - $used).' left.'
                : "Not enough campaign emails left this month: {$needed} needed, ".max(0, $limit - $used).' left.');

        throw new ApiException(402, 'plan_limit_reached', $message, $details);
    }

    /** True when the plan has no allowance at all for the channel (Free, P85-13). */
    public static function planHasNone(Tenant $tenant, string $channel): bool
    {
        return FeatureGate::limit($tenant, self::limitKey($channel)) === 0;
    }
}
