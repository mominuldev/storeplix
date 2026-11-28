<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers\Platform;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Sms\Broadcasts\BroadcastAudience;
use App\Domain\Sms\Broadcasts\BroadcastPresenter;
use App\Domain\Sms\Broadcasts\BroadcastService;
use App\Domain\Sms\Broadcasts\BroadcastTexts;
use App\Domain\Sms\Models\PlatformSmsBroadcast;
use App\Domain\Sms\Models\PlatformSmsBroadcastRecipient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\Rule;

/** PHASE-8-9B §7, §9.1 `/admin/sms/broadcasts…` (platform permission `manage_settings`). */
class PlatformSmsBroadcastController
{
    public function __construct(private readonly BroadcastService $broadcasts) {}

    public function index(Request $request): JsonResponse
    {
        $statuses = implode('|', PlatformSmsBroadcast::STATUSES);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status'],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $page = BroadcastService::query()
            ->when(isset($input['filter']['status']), fn ($q) => $q->whereIn('status', explode(',', $input['filter']['status'])))
            ->orderByDesc('created_at')->orderByDesc('id')->paginate((int) ($input['per_page'] ?? 25));

        return AdminPresenter::paginated($page, BroadcastPresenter::many($page->getCollection()), ['kpis' => BroadcastPresenter::kpis()]);
    }

    public function audiences(): JsonResponse
    {
        return AdminPresenter::json(['data' => BroadcastAudience::counts()]);
    }

    public function estimate(Request $request): JsonResponse
    {
        $input = $request->validate(BroadcastAudience::rules() + [
            'body_bn' => ['required', 'string', 'max:2000'],
            'body_en' => ['required', 'string', 'max:2000'],
        ]);
        $bn = BroadcastTexts::validate($input['body_bn'], 'bn', 'body_bn');
        $en = BroadcastTexts::validate($input['body_en'], 'en', 'body_en');

        return AdminPresenter::json(['data' => $this->broadcasts->estimate($input['audience'], $bn, $en)]);
    }

    public function test(Request $request): JsonResponse
    {
        $input = $request->validate([
            'language' => ['required', Rule::in(['bn', 'en'])],
            'phone' => ['required', 'string', 'max:20'],
            'body_bn' => ['required', 'string', 'max:2000'],
            'body_en' => ['required', 'string', 'max:2000'],
        ]);

        return AdminPresenter::json(['data' => $this->broadcasts->test($input['language'], (string) $input['phone'], $input['body_bn'], $input['body_en'],
            PlatformSmsProviderController::staff($request))]);
    }

    public function store(Request $request): JsonResponse
    {
        $input = $request->validate(self::rules(true));
        $b = $this->broadcasts->create($input, PlatformSmsProviderController::staff($request));

        return AdminPresenter::json(['data' => BroadcastPresenter::one($b)], 201);
    }

    public function show(string $broadcast): JsonResponse
    {
        return AdminPresenter::json(['data' => BroadcastPresenter::one(BroadcastService::locate($broadcast))]);
    }

    public function update(Request $request, string $broadcast): JsonResponse
    {
        $row = BroadcastService::locate($broadcast);
        $input = $request->validate(self::rules(false) + ['revision' => ['required', 'integer', 'min:1']]);

        return AdminPresenter::json(['data' => BroadcastPresenter::one($this->broadcasts->update($row, $input, PlatformSmsProviderController::staff($request)))]);
    }

    public function destroy(Request $request, string $broadcast): Response
    {
        $this->broadcasts->delete(BroadcastService::locate($broadcast), PlatformSmsProviderController::staff($request));

        return response()->noContent();
    }

    public function schedule(Request $request, string $broadcast): JsonResponse
    {
        $row = BroadcastService::locate($broadcast);
        $input = $request->validate([
            'acknowledged' => ['required', 'accepted'],
            'confirm_recipients' => ['required', 'integer', 'min:0'],
            'revision' => ['required', 'integer', 'min:1'],
        ]);

        return AdminPresenter::json(['data' => BroadcastPresenter::one($this->broadcasts->schedule($row, (int) $input['confirm_recipients'],
            (int) $input['revision'], PlatformSmsProviderController::staff($request)))]);
    }

    public function cancel(Request $request, string $broadcast): JsonResponse
    {
        return AdminPresenter::json(['data' => BroadcastPresenter::one($this->broadcasts->cancel(BroadcastService::locate($broadcast),
            PlatformSmsProviderController::staff($request)))]);
    }

    public function recipients(Request $request, string $broadcast): JsonResponse
    {
        $row = BroadcastService::locate($broadcast);
        $statuses = implode('|', PlatformSmsBroadcastRecipient::STATUSES);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status'],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $page = BroadcastService::recipients($row->id)
            ->when(isset($input['filter']['status']), fn ($q) => $q->whereIn('status', explode(',', $input['filter']['status'])))
            ->orderBy('id')->cursorPaginate(50, ['*'], 'cursor', $input['cursor'] ?? null);

        return AdminPresenter::json([
            'data' => BroadcastPresenter::recipients(collect($page->items())),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage()],
        ]);
    }

    /** @return array<string, mixed> */
    private static function rules(bool $create): array
    {
        $req = $create ? 'required' : 'sometimes';

        return [
            'name' => [$req, 'string', 'min:2', 'max:80'],
            'body_bn' => [$req, 'string', 'max:2000'],
            'body_en' => [$req, 'string', 'max:2000'],
            'scheduled_at' => [$create ? 'present' : 'sometimes', 'nullable', 'date'],
        ] + BroadcastAudience::rules('audience', $create);
    }
}
