<?php

declare(strict_types=1);

namespace App\Domain\Feeds;

use App\Domain\Feeds\Drivers\FeedDrivers;
use App\Domain\Feeds\Drivers\FeedException;
use App\Domain\Feeds\Jobs\SyncCatalog;
use App\Domain\Feeds\Models\CatalogItem;
use App\Domain\Feeds\Models\CatalogSyncRun;
use App\Domain\Identity\Models\User;
use App\Domain\Integrations\IntegrationAttention;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\IntegrationService;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * PHASE-8-9D §7: feed accounts, account choice, sync now, website claim, overview / verify, revoke. Provider calls run
 * outside transactions; writes lock the integration row. Audited per P89D-23 (ids and counts only).
 */
final class FeedService
{
    public function __construct(
        private readonly FeedDrivers $drivers,
        private readonly FeedTokens $tokens,
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    /** Row with OAuth tokens (setup_required or active), else 409 `integration_setup_required`. */
    public static function requireTokens(Store $store, string $provider): StoreIntegration
    {
        $row = IntegrationService::find($store, $provider);
        if ($row === null || ! in_array($row->status, [StoreIntegration::SETUP_REQUIRED, ...StoreIntegration::ACTIVE, StoreIntegration::ERROR], true)
            || ($row->secrets()['access_token'] ?? null) === null) {
            throw new ApiException(409, 'integration_setup_required', 'Connect your account first (Continue with …).');
        }

        return $row;
    }

    /** Connected with an account chosen, else 409 `integration_setup_required`. */
    public static function requireActive(Store $store, string $provider): StoreIntegration
    {
        $row = self::requireTokens($store, $provider);
        if ($row->status === StoreIntegration::SETUP_REQUIRED) {
            throw new ApiException(409, 'integration_setup_required', 'Choose a catalog or account to finish connecting.');
        }

        return $row;
    }

    /** @return list<array<string, mixed>> FeedAccountOption */
    public function accounts(Store $store, string $provider): array
    {
        $row = $this->fresh(self::requireTokens($store, $provider));
        try {
            $accounts = $this->drivers->for($provider)->accounts($row);
        } catch (FeedException $e) {
            throw $this->providerError($row, $e);
        }

        return array_values(array_map(fn (array $a) => ['id' => $a['id'], 'name' => $a['name'], 'parent_name' => $a['parent_name'], 'item_count' => $a['item_count']], $accounts));
    }

    /** PUT …/account (§7.2). @param array<string, mixed> $input */
    public function chooseAccount(Store $store, string $provider, array $input, User $by): StoreIntegration
    {
        $create = (bool) ($input['create_catalog'] ?? false);
        if ($create && $provider !== IntegrationProvider::META_CATALOG) {
            throw ValidationException::withMessages(['create_catalog' => ['Only a Meta catalog can be created here.']]);
        }
        if (! $create && ! is_string($input['account_id'] ?? null)) {
            throw ValidationException::withMessages(['account_id' => ['Choose an account.']]);
        }
        if ($create && ! is_string($input['parent_id'] ?? null)) {
            throw ValidationException::withMessages(['parent_id' => ['Choose the business that will own the catalog.']]);
        }
        $row = $this->fresh(self::requireTokens($store, $provider));
        try {
            $prepared = $this->drivers->for($provider)->prepareAccount($row, $create ? null : (string) $input['account_id'], $create ? (string) $input['parent_id'] : null, 'Storeplix · '.$store->name);
        } catch (FeedException $e) {
            if ($e->reason === FeedException::ACCOUNT || $e->reason === FeedException::REJECTED) {
                throw ValidationException::withMessages([$create ? 'parent_id' : 'account_id' => [$e->getMessage() !== '' ? $e->getMessage() : 'This account is not available.']]);
            }
            throw $this->providerError($row, $e);
        }

        $row = DB::transaction(function () use ($row, $prepared, $provider, $store, $by) {
            $locked = StoreIntegration::query()->whereKey($row->id)->lockForUpdate()->firstOrFail();
            $settings = array_replace((array) $locked->settings, array_intersect_key($prepared['settings'], (array) $locked->settings));
            $locked->forceFill([
                'settings' => $settings,
                'credentials' => [...$locked->secrets(), ...$prepared['credentials']],
                'status' => $locked->status === StoreIntegration::SETUP_REQUIRED ? StoreIntegration::CONNECTED : $locked->status,
                'revision' => $locked->revision + 1,
            ])->save();
            DB::table('catalog_items')->where('store_integration_id', $locked->id)->delete(); // a new destination starts empty
            $set = $provider === IntegrationProvider::GOOGLE_MERCHANT && ! (bool) ($settings['website_claimed'] ?? false) ? ['website_not_claimed' => null] : [];
            if ($store->status !== Store::STATUS_ACTIVE) {
                $set['store_not_live'] = null;
            }
            IntegrationAttention::apply($locked, $set, ['setup_incomplete']);
            $this->audit->log('integration.account_chosen', null, ['provider' => $provider, 'store_id' => $store->id,
                'account_id' => $settings['catalog_id'] ?? $settings['merchant_id'] ?? null], $by);

            return $locked;
        });
        if ($store->status === Store::STATUS_ACTIVE) {
            $run = $this->openRun($row, 'full', 'connect');
            SyncCatalog::dispatch($row->id, 'full', 'connect', $run->id)->forTenant($this->context->requireId());
        }

        return $row->refresh();
    }

    /** POST …/sync (§7.4): a `manual` full sync. 409 when a run is in progress or the store is not live. */
    public function syncNow(Store $store, string $provider, User $by): CatalogSyncRun
    {
        $row = self::requireActive($store, $provider);
        if ($store->status !== Store::STATUS_ACTIVE) {
            throw new ApiException(409, 'store_not_live', "Your shop isn't live yet. Products sync once you go live.");
        }
        $run = DB::transaction(function () use ($row) {
            StoreIntegration::query()->whereKey($row->id)->lockForUpdate()->firstOrFail();
            $busy = CatalogSyncRun::query()->where('store_integration_id', $row->id)->where('status', CatalogSyncRun::RUNNING)
                ->where('started_at', '>', now()->subMinutes(30))->exists();
            if ($busy || Cache::lock(app(CatalogSync::class)->lockKey($row->id))->get() === false) {
                throw new ApiException(409, 'feed_sync_in_progress', 'A sync is already running. It usually finishes in a few minutes.');
            }
            Cache::lock(app(CatalogSync::class)->lockKey($row->id))->forceRelease();

            return $this->openRun($row, 'manual', 'manual');
        });
        $this->audit->log('integration.sync_requested', null, ['provider' => $provider, 'store_id' => $store->id, 'run_id' => $run->id], $by);
        SyncCatalog::dispatch($row->id, 'manual', 'manual', $run->id)->forTenant($this->context->requireId());

        return $run->refresh();
    }

    /** POST …/claim-website (§7.6, P89D-32): Google only; live store with a primary host. */
    public function claimWebsite(Store $store, User $by): StoreIntegration
    {
        $provider = IntegrationProvider::GOOGLE_MERCHANT;
        $row = self::requireActive($store, $provider);
        $host = StoreDomain::query()->where('store_id', $store->id)->where('is_primary', true)->value('hostname');
        if ($store->status !== Store::STATUS_ACTIVE || ! is_string($host) || $host === '') {
            throw new ApiException(409, 'store_not_live', 'Your shop must be live on its primary address before Google can verify it.');
        }
        $row = $this->fresh($row);
        $tenantId = $this->context->requireId();
        try {
            $this->drivers->for($provider)->claimWebsite($row, $host, function (string $token) use ($row, $store, $tenantId) {
                DB::transaction(function () use ($row, $token) {
                    $locked = StoreIntegration::query()->whereKey($row->id)->lockForUpdate()->firstOrFail();
                    $locked->credentials = [...$locked->secrets(), 'site_verification_token' => $token];
                    $locked->save();
                });
                RevalidateStorefront::dispatch($store->id)->forTenant($tenantId);
            });
        } catch (FeedException $e) {
            if ($e->reason === FeedException::UNAVAILABLE || $e->reason === FeedException::RATE_LIMITED) {
                throw new ApiException(502, 'provider_unavailable', "Google didn't answer. Try again in a minute.");
            }
            if ($e->reason === FeedException::AUTH) {
                $this->tokens->flag($row, 'token_invalid');
            }

            throw new ApiException(422, 'website_claim_failed', match ($e->step) {
                'verify' => "Google couldn't see the verification tag on your shop yet. Try again in a few minutes.",
                'claim' => 'Google verified your shop but the claim failed. Another Merchant Center account may own it.',
                default => "Google didn't give us a verification token.",
            }, ['step' => $e->step ?? 'token']);
        }
        $row = DB::transaction(function () use ($row, $store, $host, $by) {
            $locked = StoreIntegration::query()->whereKey($row->id)->lockForUpdate()->firstOrFail();
            $locked->settings = array_replace((array) $locked->settings, ['website_claimed' => true]);
            $locked->revision++;
            $locked->save();
            IntegrationAttention::apply($locked, [], ['website_not_claimed']);
            $this->audit->log('integration.website_claimed', null, ['provider' => IntegrationProvider::GOOGLE_MERCHANT, 'store_id' => $store->id, 'host' => $host], $by);

            return $locked;
        });
        RevalidateStorefront::dispatch($store->id)->forTenant($this->context->requireId())->afterCommit();

        return $row->refresh();
    }

    /** @return array<string, mixed> FeedOverview */
    public function overview(Store $store, string $provider): array
    {
        $row = IntegrationService::find($store, $provider);
        $id = $row?->id ?? '';
        $last = CatalogSyncRun::query()->where('store_integration_id', $id)->orderByDesc('started_at')->orderByDesc('id')->first();
        $items = CatalogItem::query()->where('store_integration_id', $id)->whereNot('issues', '[]')->whereNotNull('issues')->get(['issues', 'review_status']);
        $groups = [];
        foreach ($items as $item) {
            foreach ((array) $item->issues as $issue) {
                $code = (string) ($issue['code'] ?? 'issue');
                $groups[$code] ??= ['code' => $code, 'message' => (string) ($issue['message'] ?? ''), 'severity' => ($issue['severity'] ?? 'warning') === 'error' ? 'error' : 'warning',
                    'impact' => null, 'products' => 0, 'fix' => $issue['fix'] ?? null];
                $groups[$code]['products']++;
                if (in_array($item->review_status, ['disapproved', 'limited'], true)) {
                    $groups[$code]['impact'] = $item->review_status === 'disapproved' || $groups[$code]['impact'] === 'disapproved' ? 'disapproved' : 'limited';
                }
            }
        }
        usort($groups, fn (array $a, array $b) => [$a['severity'] === 'error' ? 0 : 1, -$a['products']] <=> [$b['severity'] === 'error' ? 0 : 1, -$b['products']]);

        return [
            'provider' => $provider,
            'counts' => self::counts($id),
            'issues' => array_values($groups),
            'last_run' => $last !== null ? self::run($last) : null,
            'next_full_sync_at' => $row !== null && $row->isActive() ? now()->addHour()->startOfHour()->toIso8601ZuluString() : null,
            'clicks_30d' => null,
        ];
    }

    /** @return array{total: int, approved: int, in_review: int, with_issues: int, not_sent: int} */
    public static function counts(string $integrationId): array
    {
        $q = fn () => CatalogItem::query()->where('store_integration_id', $integrationId);

        return [
            'total' => $q()->where('status', '<>', CatalogItem::EXCLUDED)->count(),
            'approved' => $q()->where('review_status', 'approved')->count(),
            'in_review' => $q()->where('status', CatalogItem::SYNCED)->where(fn ($w) => $w->whereNull('review_status')->orWhere('review_status', 'in_review'))->count(),
            'with_issues' => $q()->where(fn ($w) => $w->whereIn('review_status', ['disapproved', 'limited'])->orWhere('status', CatalogItem::ERROR))->count(),
            'not_sent' => $q()->whereIn('status', [CatalogItem::EXCLUDED, CatalogItem::PENDING])->count(),
        ];
    }

    /** @return array<string, mixed> CatalogSyncRun */
    public static function run(CatalogSyncRun $run): array
    {
        return [
            'id' => $run->id, 'kind' => $run->kind, 'trigger' => $run->trigger, 'status' => $run->status,
            'items_sent' => $run->items_sent, 'items_failed' => $run->items_failed, 'items_deleted' => $run->items_deleted,
            'error_code' => $run->error_code, 'started_at' => UserRef::iso($run->started_at), 'finished_at' => UserRef::iso($run->finished_at),
        ];
    }

    /** §4.5 feed rows. @return array{0: list<array<string, mixed>>, 1: array<string, int|null>, 2: list<string>, 3: string|null} */
    public function verify(Store $store, StoreIntegration $row): array
    {
        $rows = [];
        $set = [];
        $remove = [];
        $found = null;
        try {
            $row = $this->fresh($row);
            $rows[] = IntegrationService::row('token', 'Access', 'ok', 'Valid');
            $accounts = $this->drivers->for($row->provider)->accounts($row);
            $chosen = $row->provider === IntegrationProvider::META_CATALOG ? $row->setting('catalog_id') : $row->setting('merchant_id');
            $match = collect($accounts)->firstWhere('id', (string) $chosen);
            $found = $match['name'] ?? null;
            $rows[] = IntegrationService::row('account', $row->provider === IntegrationProvider::META_CATALOG ? 'Catalog' : 'Merchant Center account',
                $chosen === null ? 'warn' : ($match !== null ? 'ok' : 'fail'), $chosen === null ? 'Not chosen yet' : ($match !== null ? $found : 'Not reachable with this access'));
            $remove[] = 'token_invalid';
        } catch (FeedException $e) {
            $state = $e->reason === FeedException::AUTH ? 'fail' : 'warn';
            $rows[] = IntegrationService::row('token', 'Access', $state, $state === 'fail' ? 'Reconnect: the provider refused our access.' : 'The provider did not answer.');
            if ($e->reason === FeedException::AUTH) {
                $set['token_invalid'] = null;
            }
        }
        if ($row->provider === IntegrationProvider::GOOGLE_MERCHANT) {
            $claimed = (bool) $row->setting('website_claimed', false);
            $rows[] = IntegrationService::row('website', 'Website claimed', $claimed ? 'ok' : 'warn', $claimed ? 'Verified and claimed' : 'Not claimed yet');
        }
        $last = CatalogSyncRun::query()->where('store_integration_id', $row->id)->orderByDesc('started_at')->first();
        $rows[] = IntegrationService::row('last_run', 'Last sync', $last === null ? 'skipped' : ($last->status === CatalogSyncRun::FAILED ? 'fail' : ($last->status === CatalogSyncRun::PARTIAL ? 'warn' : 'ok')),
            $last === null ? 'Not synced yet' : $last->status);

        return [$rows, $set, $remove, $found];
    }

    /** Best-effort token revoke on disconnect (P89D-31); never blocks the disconnect. */
    public function revoke(StoreIntegration $row): void
    {
        try {
            if (($row->secrets()['access_token'] ?? null) !== null) {
                $this->drivers->for($row->provider)->revoke($row);
            }
        } catch (Throwable $e) {
            Log::info('feeds.revoke_failed', ['integration_id' => $row->id, 'error' => $e::class]);
        }
    }

    /** Feed settings changed: everything is re-evaluated by the next delta. */
    public function settingsChanged(StoreIntegration $row): void
    {
        DB::table('catalog_items')->where('store_integration_id', $row->id)->update(['dirty_at' => now()]);
        $productIds = DB::table('product_variants')->where('store_id', $row->store_id)->whereNull('deleted_at')->distinct()->pluck('product_id');
        foreach ($productIds as $productId) {
            FeedHooks::product($row->store_id, (string) $productId);
        }
    }

    private function openRun(StoreIntegration $row, string $kind, string $trigger): CatalogSyncRun
    {
        $run = new CatalogSyncRun;
        $run->forceFill(['store_id' => $row->store_id, 'store_integration_id' => $row->id, 'kind' => $kind, 'trigger' => $trigger,
            'status' => CatalogSyncRun::RUNNING, 'started_at' => now()])->save();

        return $run;
    }

    private function fresh(StoreIntegration $row): StoreIntegration
    {
        try {
            return $this->tokens->fresh($row);
        } catch (FeedException $e) {
            throw $this->providerError($row, $e);
        }
    }

    private function providerError(StoreIntegration $row, FeedException $e): ApiException
    {
        if ($e->reason === FeedException::AUTH) {
            $this->tokens->flag($row, 'token_invalid');

            return new ApiException(409, 'integration_setup_required', 'The provider refused our access. Reconnect to continue.');
        }

        return new ApiException(502, 'provider_unavailable', "The provider didn't answer. Try again in a minute.");
    }
}
