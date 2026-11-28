<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Console;

use App\Domain\Billing\FeatureGate;
use App\Domain\Feeds\Drivers\FeedDrivers;
use App\Domain\Feeds\Drivers\FeedException;
use App\Domain\Feeds\FeedTokens;
use App\Domain\Integrations\IntegrationAttention;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * `integrations:health` (daily 03:00 Dhaka, PHASE-8-9D §4.4 / P89D-26 / P89D-40): Meta tokens with < 10 days left are
 * re-exchanged, else `token_expiring` (7 d) → `token_expired`; gated integrations on a plan without the feature get
 * `plan_required` (paused, reads stay), removed when the plan allows again. Discovery on the platform connection, work
 * inside each tenant.
 */
class IntegrationsHealth extends Command
{
    protected $signature = 'integrations:health';

    protected $description = 'Check integration tokens, plan access and attention reasons';

    public function handle(TenantContext $context, FeedDrivers $drivers, FeedTokens $tokens): int
    {
        // cross-tenant: scheduler discovery (platform connection); each row is checked inside its tenant.
        $rows = StoreIntegration::withoutTenancy()->whereNotIn('status', [StoreIntegration::DISCONNECTED])->orderBy('id')->get(['id', 'tenant_id']);
        $checked = 0;
        foreach ($rows as $ref) {
            $context->run((string) $ref->tenant_id, function () use ($ref, $drivers, $tokens, $context, &$checked) {
                $row = StoreIntegration::query()->find($ref->id);
                if ($row === null) {
                    return;
                }
                $checked++;
                $set = [];
                $remove = [];
                $feature = IntegrationProvider::feature($row->provider);
                $tenant = $context->tenant();
                if ($feature !== null && $tenant !== null) {
                    FeatureGate::allows($tenant, $feature) ? $remove[] = 'plan_required' : $set['plan_required'] = null;
                }
                if ($row->provider === IntegrationProvider::META_CATALOG && $row->token_expires_at !== null) {
                    $left = now()->diffInDays($row->token_expires_at, false);
                    if ($row->token_expires_at->isPast()) {
                        $set['token_expired'] = null;
                    } elseif ($left < (int) config('feeds.meta.renew_when_days_left', 10)) {
                        try {
                            $tokens->store($row, $drivers->for($row->provider)->refresh($row));
                            $remove[] = 'token_expiring';
                        } catch (FeedException) {
                            if ($left <= 7) {
                                $set['token_expiring'] = (int) max(0, floor($left));
                            }
                        }
                    }
                }
                if ($set !== [] || $remove !== []) {
                    DB::transaction(function () use ($row, $set, $remove) {
                        $locked = StoreIntegration::query()->whereKey($row->id)->lockForUpdate()->first();
                        if ($locked !== null) {
                            IntegrationAttention::apply($locked, $set, $remove);
                        }
                    });
                }
            });
        }
        $this->info("integrations:health: {$checked} integration(s) checked.");

        return self::SUCCESS;
    }
}
