<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Http\Controllers;

use App\Domain\Feeds\FeedOauth;
use App\Domain\Feeds\FeedService;
use App\Domain\Feeds\Models\CatalogItem;
use App\Domain\Feeds\Models\CatalogSyncRun;
use App\Domain\Integrations\Http\Controllers\IntegrationController;
use App\Domain\Integrations\IntegrationPresenter;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\IntegrationService;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** PHASE-8-9D §7 (openapi tag `integrations`): OAuth start, accounts, account, feed, sync, sync-runs, items, claim-website. */
final class FeedController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly FeedService $feeds,
        private readonly FeedOauth $oauth,
        private readonly IntegrationService $integrations,
    ) {}

    public function oauthStart(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::FEEDS);
        $this->integrations->assertPlan($provider);

        return new JsonResponse(['data' => $this->oauth->start($store, $provider, IntegrationController::user($request))], 200, self::NO_STORE);
    }

    public function accounts(Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::FEEDS);

        return new JsonResponse(['data' => $this->feeds->accounts($store, $provider)], 200, self::NO_STORE);
    }

    public function account(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::FEEDS);
        $this->integrations->assertPlan($provider);
        $input = $request->validate([
            'account_id' => ['sometimes', 'nullable', 'string', 'max:64', 'regex:/^[0-9A-Za-z_\-]+$/'],
            'create_catalog' => ['sometimes', 'boolean:strict'],
            'parent_id' => ['sometimes', 'nullable', 'string', 'max:64', 'regex:/^[0-9A-Za-z_\-]+$/'],
        ]);
        $row = $this->feeds->chooseAccount($store, $provider, $input, IntegrationController::user($request));

        return new JsonResponse(['data' => IntegrationPresenter::full($provider, $row)], 200, self::NO_STORE);
    }

    public function overview(Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::FEEDS);

        return new JsonResponse(['data' => $this->feeds->overview($store, $provider)], 200, self::NO_STORE);
    }

    public function sync(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::FEEDS);
        $this->integrations->assertPlan($provider);
        $run = $this->feeds->syncNow($store, $provider, IntegrationController::user($request));

        return new JsonResponse(['data' => FeedService::run($run)], 202, self::NO_STORE);
    }

    public function runs(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::FEEDS);
        $input = $request->validate(['cursor' => ['sometimes', 'nullable', 'string', 'max:500']]);
        $row = IntegrationService::find($store, $provider);
        $page = CatalogSyncRun::query()->where('store_id', $store->id)->where('store_integration_id', $row?->id ?? '')
            ->orderByDesc('started_at')->orderByDesc('id')->cursorPaginate(50, ['*'], 'cursor', $input['cursor'] ?? null);

        return new JsonResponse([
            'data' => collect($page->items())->map(fn (CatalogSyncRun $r) => FeedService::run($r))->values()->all(),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage()],
        ], 200, self::NO_STORE);
    }

    public function items(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::FEEDS);
        $input = $request->validate([
            'status' => ['sometimes', 'string', 'max:100', 'regex:/^(pending|synced|error|excluded|deleting)(,(pending|synced|error|excluded|deleting))*$/'],
            'review_status' => ['sometimes', 'string', 'max:100', 'regex:/^(approved|in_review|limited|disapproved)(,(approved|in_review|limited|disapproved))*$/'],
            'has_issues' => ['sometimes', 'in:0,1'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);
        $row = IntegrationService::find($store, $provider);
        $id = $row?->id ?? '';
        $query = CatalogItem::query()->where('store_id', $store->id)->where('store_integration_id', $id);
        if (isset($input['status'])) {
            $query->whereIn('status', explode(',', $input['status']));
        }
        if (isset($input['review_status'])) {
            $query->whereIn('review_status', explode(',', $input['review_status']));
        }
        if (isset($input['has_issues'])) {
            $input['has_issues'] === '1' ? $query->whereNotNull('issues')->whereNot('issues', '[]') : $query->where('issues', '[]');
        }
        if (($q = trim((string) ($input['q'] ?? ''))) !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($q)).'%';
            $query->whereIn('product_id', DB::table('products')->where('store_id', $store->id)->whereRaw('LOWER(name) LIKE ?', [$like])->select('id'));
        }
        $page = $query->orderBy('product_id')->orderBy('id')->cursorPaginate(50, ['*'], 'cursor', $input['cursor'] ?? null);
        $items = collect($page->items());
        $products = DB::table('products')->whereIn('id', $items->pluck('product_id')->unique()->all())->whereNull('deleted_at')->get(['id', 'name', 'slug'])->keyBy('id');
        $variants = DB::table('product_variants')->whereIn('id', $items->pluck('variant_id')->unique()->all())->whereNull('deleted_at')->get(['id', 'title', 'sku'])->keyBy('id');

        return new JsonResponse([
            'data' => $items->map(fn (CatalogItem $i) => [
                'id' => $i->id,
                'product' => ($p = $products->get($i->product_id)) !== null ? ['id' => $p->id, 'name' => $p->name, 'slug' => $p->slug] : null,
                'variant' => ($v = $variants->get($i->variant_id)) !== null ? ['id' => $v->id, 'title' => $v->title, 'sku' => $v->sku] : null,
                'status' => $i->status,
                'review_status' => $i->review_status,
                'excluded_reason' => $i->excluded_reason,
                'issues' => array_values((array) $i->issues),
                'last_synced_at' => $i->last_synced_at?->toIso8601ZuluString(),
            ])->values()->all(),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage(),
                'counts' => FeedService::counts($id)],
        ], 200, self::NO_STORE);
    }

    public function claimWebsite(Request $request, Store $store, string $provider): JsonResponse
    {
        IntegrationProvider::assertIn($provider, [IntegrationProvider::GOOGLE_MERCHANT]);
        $this->integrations->assertPlan($provider);
        $row = $this->feeds->claimWebsite($store, IntegrationController::user($request));

        return new JsonResponse(['data' => IntegrationPresenter::full($provider, $row)], 200, self::NO_STORE);
    }
}
