<?php

namespace App\Domain\Media\Http\Controllers;

use App\Domain\Media\Http\Requests\UploadMediaRequest;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;

class MediaController
{
    public function __construct(
        private readonly TenantStorage $storage,
        private readonly AuditLogger $audit,
    ) {}

    public function store(UploadMediaRequest $request): JsonResponse
    {
        $info = $request->inspected;
        $file = $request->file('file');
        $id = strtolower((string) Str::ulid());
        $disk = $this->storage->diskName();
        $path = $this->storage->path($id, 'original.'.MediaPurpose::extensionFor($info['mime']));

        $this->storage->disk($disk)->put($path, (string) file_get_contents($file->getRealPath()));

        $media = new Media([
            'purpose' => $request->validated('purpose'),
            'disk' => $disk,
            'path' => $path,
            'mime' => $info['mime'],
            'size_bytes' => (int) $file->getSize(),
            'width' => $info['width'],
            'height' => $info['height'],
            'checksum' => hash_file('sha256', $file->getRealPath()),
            'alt' => $request->validated('alt'),
            'uploaded_by' => $request->user()->getKey(),
        ]);
        $media->id = $id;
        $media->save();

        ProcessMedia::dispatch($media->id);

        return new JsonResponse(['data' => MediaPresenter::media($media->refresh())], 201);
    }

    /** GET /media?filter[purpose]=page_image,logo&page&per_page — newest first, failed excluded. Any role. */
    public function index(Request $request): JsonResponse
    {
        // PHASE-8-7 §5.4: library purposes only; receipts are never listed (filtered or not).
        $purposes = implode('|', MediaPurpose::libraryValues());
        $input = $request->validate([
            'filter' => ['sometimes', 'array:purpose'],
            'filter.purpose' => ['sometimes', 'string', "regex:/^({$purposes})(,({$purposes}))*$/"],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:60'],
        ]);

        $paginator = Media::query()
            ->where('status', '!=', Media::FAILED)
            ->whereIn('purpose', MediaPurpose::libraryValues())
            ->when(isset($input['filter']['purpose']), fn ($q) => $q->whereIn('purpose', explode(',', $input['filter']['purpose'])))
            ->orderByDesc('created_at')->orderByDesc('id')
            ->paginate((int) ($input['per_page'] ?? 24));

        return new JsonResponse([
            'data' => $paginator->getCollection()->map(MediaPresenter::media(...))->all(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
            ],
        ]);
    }

    public function show(Media $media): JsonResponse
    {
        self::assertLibrary($media);
        Gate::authorize('view', $media);

        return new JsonResponse(['data' => MediaPresenter::media($media)]);
    }

    public function destroy(Media $media): Response
    {
        self::assertLibrary($media);
        Gate::authorize('delete', $media);

        if ($this->inUse($media)) {
            throw new ApiException(409, 'media_in_use', 'This image is used in your shop (logo, favicon, share image, theme or a page). Replace it first.');
        }

        try {
            // Own transaction (a savepoint when nested) so a Postgres FK error doesn't abort an outer transaction.
            DB::transaction(fn () => $media->delete());
        } catch (QueryException $e) {
            // FK RESTRICT (store_settings / store_pages) → same 409.
            throw new ApiException(409, 'media_in_use', 'This image is used in your shop. Replace it first.');
        }
        $this->storage->deleteAll($media);
        $this->audit->log('media.deleted', $media, ['purpose' => $media->purpose]);

        return response()->noContent();
    }

    /** PHASE-8-7 §5.4: a receipt is 404 here, checked before the policy (no existence leak); only the expenses domain deletes it. */
    private static function assertLibrary(Media $media): void
    {
        if (! (MediaPurpose::tryFrom($media->purpose)?->isLibrary() ?? false)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
    }

    /**
     * Phase 3 §2: referenced by store settings (logo, favicon, share image), a page's share image, or anywhere in a
     * theme config / page body of this tenant (ULIDs are unique, so a tenant-scoped JSON text scan is exact enough).
     */
    private function inUse(Media $media): bool
    {
        $id = $media->id;
        $like = '%"'.$id.'"%';

        return StoreSetting::query()
            ->where(fn ($q) => $q->where('logo_media_id', $id)->orWhere('favicon_media_id', $id)->orWhere('og_image_media_id', $id))
            ->exists()
            || StorePage::query()->where(fn ($q) => $q->where('og_image_media_id', $id)->orWhereRaw('CAST(body AS TEXT) LIKE ?', [$like]))->exists()
            || StoreTheme::query()->where(fn ($q) => $q->whereRaw('CAST(draft_config AS TEXT) LIKE ?', [$like])->orWhereRaw('CAST(published_config AS TEXT) LIKE ?', [$like]))->exists();
    }
}
