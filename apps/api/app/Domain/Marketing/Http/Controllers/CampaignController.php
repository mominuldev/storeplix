<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Http\Controllers;

use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Marketing\Audience\AudienceDefinition;
use App\Domain\Marketing\Audience\AudienceQuery;
use App\Domain\Marketing\CampaignService;
use App\Domain\Marketing\Content\CampaignRenderer;
use App\Domain\Marketing\Content\MessageSpec;
use App\Domain\Marketing\Http\Requests\AudienceInputRequest;
use App\Domain\Marketing\Http\Requests\CampaignRequest;
use App\Domain\Marketing\Http\Resources\CampaignPresenter;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Marketing\Models\CampaignConversion;
use App\Domain\Marketing\Models\CampaignRecipient;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Validation\Rule;

/**
 * PHASE-8-5 §6.1 `/stores/{store}/campaigns…` (perm:marketing.manage; recipients also customers.view). `{campaign}`
 * resolves inside the store and the tenant: another store's or tenant's id → 404 `not_found`.
 */
class CampaignController
{
    public function __construct(private readonly CampaignService $campaigns) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $statuses = implode('|', Campaign::STATUSES);
        $input = $request->validate([
            'status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter' => ['sometimes', 'array:status,channel'],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter.channel' => ['sometimes', 'string', Rule::in(Campaign::CHANNELS)],
            'channel' => ['sometimes', 'string', Rule::in(Campaign::CHANNELS)],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'sort' => ['sometimes', 'string', 'in:-created_at,-started_at'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $query = Campaign::query()->where('store_id', $store->id)->with(CampaignPresenter::with());
        $status = $input['filter']['status'] ?? $input['status'] ?? null;
        if ($status !== null) {
            $query->whereIn('status', explode(',', $status));
        }
        if (($channel = $input['filter']['channel'] ?? $input['channel'] ?? null) !== null) {
            $query->where('channel', $channel);
        }
        $q = trim((string) ($input['q'] ?? ''));
        if ($q !== '') {
            $query->whereRaw('lower(name) like ?', ['%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($q)).'%']);
        }
        ($input['sort'] ?? '-created_at') === '-started_at'
            ? $query->orderByRaw('started_at is null')->orderByDesc('started_at')->orderByDesc('id')
            : $query->orderByDesc('created_at')->orderByDesc('id');
        $page = $query->paginate((int) ($input['per_page'] ?? 25));
        $conversions = CampaignPresenter::conversions($store->id, $page->getCollection()->pluck('id')->all());

        return new JsonResponse([
            'data' => $page->getCollection()->map(fn (Campaign $c) => CampaignPresenter::listItem($c, $store->currency, $conversions))->values()->all(),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
            ],
        ]);
    }

    public function store(CampaignRequest $request, Store $store): JsonResponse
    {
        $campaign = $this->campaigns->create($store, $request->campaignInput(), $request->user());

        return $this->one($store, $campaign, 201);
    }

    public function show(Store $store, string $campaign): JsonResponse
    {
        return $this->one($store, self::find($store, $campaign));
    }

    public function update(CampaignRequest $request, Store $store, string $campaign): JsonResponse
    {
        $row = self::find($store, $campaign);

        return $this->one($store, $this->campaigns->update($store, $row, $request->campaignInput(), (int) $request->validated()['revision']));
    }

    public function destroy(Store $store, string $campaign): Response
    {
        $this->campaigns->delete(self::find($store, $campaign));

        return response()->noContent();
    }

    public function duplicate(Request $request, Store $store, string $campaign): JsonResponse
    {
        return $this->one($store, $this->campaigns->duplicate($store, self::find($store, $campaign), $request->user()), 201);
    }

    public function schedule(Request $request, Store $store, string $campaign): JsonResponse
    {
        $row = self::find($store, $campaign);
        $input = $request->validate(['scheduled_at' => ['required', 'date']]);

        return $this->one($store, $this->campaigns->schedule($store, $row, Carbon::parse($input['scheduled_at'])->utc()));
    }

    public function send(Store $store, string $campaign): JsonResponse
    {
        $row = $this->campaigns->sendNow($store, self::find($store, $campaign));
        $response = $this->one($store, $row, 202);
        $this->campaigns->dispatchStart($row);

        return $response;
    }

    public function unschedule(Store $store, string $campaign): JsonResponse
    {
        return $this->one($store, $this->campaigns->unschedule(self::find($store, $campaign)));
    }

    public function cancel(Store $store, string $campaign): JsonResponse
    {
        return $this->one($store, $this->campaigns->cancel(self::find($store, $campaign)));
    }

    public function test(Request $request, Store $store, string $campaign): JsonResponse
    {
        return new JsonResponse(['data' => $this->campaigns->test($store, self::find($store, $campaign), $request->user())], 202);
    }

    public function preview(AudienceInputRequest $request, Store $store): JsonResponse
    {
        $input = $request->validated();
        $audience = AudienceDefinition::from($request->input('audience'));

        return new JsonResponse(['data' => AudienceQuery::for($store->id, $input['channel'], $audience)->preview()]);
    }

    public function estimate(AudienceInputRequest $request, Store $store): JsonResponse
    {
        $input = $request->validated();
        $audience = AudienceDefinition::from($request->input('audience'));
        $coupon = isset($input['coupon_id']) ? Coupon::query()->where('store_id', $store->id)->whereKey(strtolower($input['coupon_id']))->first() : null;
        $product = isset($input['product_id']) ? Product::query()->where('store_id', $store->id)->whereKey(strtolower($input['product_id']))->first() : null;
        $spec = MessageSpec::from($input['channel'], $input['language'], trim((string) ($input['body'] ?? '')), $input['subject'] ?? null, $coupon, $product);
        CampaignRenderer::assertKnownFields($spec->body, (string) $spec->subject);

        return new JsonResponse(['data' => $this->campaigns->estimate($store, $spec, $audience)]);
    }

    /** GET …/recipients (perm marketing.manage AND customers.view): cursor pages of 50, masked addresses. */
    public function recipients(Request $request, Store $store, string $campaign): JsonResponse
    {
        $row = self::find($store, $campaign);
        $statuses = implode('|', CampaignRecipient::STATUSES);
        $reasons = implode('|', CampaignRecipient::SKIP_REASONS);
        $input = $request->validate([
            'status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'skip_reason' => ['sometimes', 'string', "regex:/^({$reasons})(,({$reasons}))*$/"],
            'filter' => ['sometimes', 'array:status,skip_reason'],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter.skip_reason' => ['sometimes', 'string', "regex:/^({$reasons})(,({$reasons}))*$/"],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $query = CampaignRecipient::query()->where('store_id', $store->id)->where('campaign_id', $row->id)->with('customer');
        if (($status = $input['filter']['status'] ?? $input['status'] ?? null) !== null) {
            $query->whereIn('status', explode(',', $status));
        }
        if (($reason = $input['filter']['skip_reason'] ?? $input['skip_reason'] ?? null) !== null) {
            $query->whereIn('skip_reason', explode(',', $reason));
        }
        $page = $query->orderBy('id')->cursorPaginate(50, ['*'], 'cursor', $input['cursor'] ?? null);
        $ids = collect($page->items())->pluck('id')->all();
        $orders = [];
        if ($ids !== []) {
            $conversions = CampaignConversion::query()->whereIn('recipient_id', $ids)->get(['recipient_id', 'order_id']);
            $byId = Order::query()->whereIn('id', $conversions->pluck('order_id')->all())->get(['id', 'number', 'total_amount', 'status'])->keyBy('id');
            foreach ($conversions as $conv) {
                $order = $byId[$conv->order_id] ?? null;
                if ($order !== null) {
                    $orders[$conv->recipient_id] = ['id' => $order->id, 'number' => $order->number, 'total_amount' => (int) $order->total_amount];
                }
            }
        }

        return new JsonResponse([
            'data' => collect($page->items())->map(fn (CampaignRecipient $r) => CampaignPresenter::recipient($r, $orders))->values()->all(),
            'meta' => [
                'next_cursor' => $page->nextCursor()?->encode(),
                'prev_cursor' => $page->previousCursor()?->encode(),
                'per_page' => $page->perPage(),
            ],
        ]);
    }

    public static function find(Store $store, string $id): Campaign
    {
        return Campaign::query()->where('store_id', $store->id)->whereKey(strtolower($id))->firstOrFail();
    }

    private function one(Store $store, Campaign $campaign, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => CampaignPresenter::campaign($campaign->refresh(), $store->currency)], $status);
    }
}
