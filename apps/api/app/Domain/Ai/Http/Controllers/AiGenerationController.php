<?php

declare(strict_types=1);

namespace App\Domain\Ai\Http\Controllers;

use App\Domain\Ai\AiGenerationPresenter;
use App\Domain\Ai\AiGenerationService;
use App\Domain\Ai\AiPhotoLibrary;
use App\Domain\Ai\Models\AiGeneration;
use App\Domain\Billing\Http\Controllers\BillingChangeController;
use App\Domain\Identity\Models\User;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * PHASE-8-9D §11 (openapi tag `ai`): write a description, edit a photo (202, Idempotency-Key, credits charged in the same
 * transaction that creates the generation), history, poll one, apply / undo a photo. Every route `products.edit` (route
 * middleware); impersonation never reaches the writes (ResolveTenant, P89D-42). A generation of another store → 404.
 */
final class AiGenerationController
{
    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly AiGenerationService $service,
        private readonly AiPhotoLibrary $photos,
    ) {}

    public function describe(Request $request, Store $store): JsonResponse
    {
        $key = BillingChangeController::idempotencyKey($request);
        $g = $this->service->describe($store, self::body($request), self::user($request), $key);

        return $this->one($g, 202);
    }

    public function editPhoto(Request $request, Store $store): JsonResponse
    {
        $key = BillingChangeController::idempotencyKey($request);
        $g = $this->service->editPhoto($store, self::body($request), self::user($request), $key);

        return $this->one($g, 202);
    }

    public function index(Request $request, Store $store): JsonResponse
    {
        $statuses = implode('|', AiGeneration::STATUSES);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:kind,status,product_id'],
            'filter.kind' => ['sometimes', 'string', 'in:'.implode(',', AiGeneration::KINDS)],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter.product_id' => ['sometimes', 'string', 'size:26'],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $f = (array) ($input['filter'] ?? []);
        $page = AiGeneration::query()->where('store_id', $store->id)->with(['product', 'requester'])
            ->where('created_at', '>=', now()->subDays((int) config('ai.retention.outputs', 90)))
            ->when(isset($f['kind']), fn ($q) => $q->where('kind', $f['kind']))
            ->when(isset($f['status']), fn ($q) => $q->whereIn('status', explode(',', (string) $f['status'])))
            ->when(isset($f['product_id']), fn ($q) => $q->where('product_id', strtolower((string) $f['product_id'])))
            ->orderByDesc('created_at')->orderByDesc('id')
            ->cursorPaginate(50, ['*'], 'cursor', $input['cursor'] ?? null);

        return new JsonResponse([
            'data' => array_values(array_map(fn (AiGeneration $g) => AiGenerationPresenter::present($g), $page->items())),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage()],
        ], 200, self::NO_STORE);
    }

    public function show(Store $store, string $generation): JsonResponse
    {
        return $this->one($this->find($store, $generation));
    }

    public function apply(Request $request, Store $store, string $generation): JsonResponse
    {
        $input = $request->validate([
            'product_id' => ['required', 'string', 'size:26'],
            'replace_image_id' => ['sometimes', 'nullable', 'string', 'size:26'],
        ]);
        $g = $this->photos->apply($store, $this->find($store, $generation), (string) $input['product_id'], $input['replace_image_id'] ?? null, self::user($request));

        return $this->one($g);
    }

    public function undo(Request $request, Store $store, string $generation): JsonResponse
    {
        return $this->one($this->photos->undo($store, $this->find($store, $generation), self::user($request)));
    }

    /**
     * GET /ai-photos/{media}/download (signed, 30 minutes, no session; tenant from the signature). Only an `ai_photo`
     * result on the private disk under the tenant prefix is served (S346).
     */
    public function download(Request $request, string $media, TenantContext $context, TenantStorage $storage): StreamedResponse
    {
        return $context->run((string) $request->query('tenant'), function () use ($media, $storage) {
            $row = Media::query()->whereKey(strtolower($media))->first();
            if ($row === null || $row->purpose !== MediaPurpose::AiPhoto->value || $row->status !== Media::READY
                || $row->disk !== $storage->privateDiskName() || ! $storage->ownsPath($row->path)) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }

            return $storage->privateDisk()->response($row->path, 'ai-photo.'.MediaPurpose::extensionFor($row->mime), [
                'Content-Type' => $row->mime,
                'X-Content-Type-Options' => 'nosniff',
                'Content-Security-Policy' => "sandbox; default-src 'none'",
                'Cache-Control' => 'private, no-store',
                'Referrer-Policy' => 'no-referrer',
            ], 'inline');
        });
    }

    private function find(Store $store, string $id): AiGeneration
    {
        return AiGeneration::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    private function one(AiGeneration $g, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => AiGenerationPresenter::present($g->load(['product', 'requester']))], $status, self::NO_STORE);
    }

    /** @return array<string, mixed> */
    private static function body(Request $request): array
    {
        return (array) $request->json()->all();
    }

    private static function user(Request $request): User
    {
        /** @var User $user */
        $user = $request->user();

        return $user;
    }
}
