<?php

namespace App\Domain\Media\Http\Controllers;

use App\Domain\Media\Http\Requests\UploadMediaRequest;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Response;
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

    public function show(Media $media): JsonResponse
    {
        Gate::authorize('view', $media);

        return new JsonResponse(['data' => MediaPresenter::media($media)]);
    }

    public function destroy(Media $media): Response
    {
        Gate::authorize('delete', $media);

        $inUse = StoreSetting::query()
            ->where(fn ($q) => $q->where('logo_media_id', $media->id)->orWhere('favicon_media_id', $media->id))
            ->exists();
        if ($inUse) {
            throw new ApiException(409, 'media_in_use', 'This image is used as your logo or favicon. Replace it first.');
        }

        $media->delete();
        $this->storage->deleteAll($media);
        $this->audit->log('media.deleted', $media, ['purpose' => $media->purpose]);

        return response()->noContent();
    }
}
